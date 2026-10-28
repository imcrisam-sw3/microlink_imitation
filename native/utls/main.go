package main

import (
	"bufio"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
	"golang.org/x/net/publicsuffix"
)

const maxBodyBytes = 16 << 20

type requestMessage struct {
	ID       uint64            `json:"id"`
	Type     string            `json:"type"`
	Method   string            `json:"method"`
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers"`
	Body     string            `json:"body"`
	Redirect string            `json:"redirect"`
}
type responseMessage struct {
	ID       uint64      `json:"id"`
	Status   int         `json:"status,omitempty"`
	Headers  http.Header `json:"headers,omitempty"`
	Body     []byte      `json:"body,omitempty"`
	URL      string      `json:"url,omitempty"`
	Protocol string      `json:"protocol,omitempty"`
	Error    string      `json:"error,omitempty"`
}

func main() {
	profile := flag.String("profile", "chrome", "TLS ClientHello profile")
	timeoutMS := flag.Int("timeout-ms", 20000, "request timeout")
	caFile := flag.String("ca-file", "", "additional trusted CA PEM")
	flag.Parse()
	if err := run(*profile, *caFile, time.Duration(*timeoutMS)*time.Millisecond); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(profile, caFile string, timeout time.Duration) error {
	if timeout <= 0 {
		return errors.New("timeout must be positive")
	}
	var roots *x509.CertPool
	if caFile != "" {
		var err error
		roots, err = x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return err
		}
		if !roots.AppendCertsFromPEM(pem) {
			return errors.New("CA file contains no certificates")
		}
	}
	transport, err := newTransport(profile, roots)
	if err != nil {
		return err
	}
	defer transport.CloseIdleConnections()
	client, err := newSession(transport, timeout)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	var outputMu sync.Mutex
	send := func(message any) {
		outputMu.Lock()
		defer outputMu.Unlock()
		if err := encoder.Encode(message); err != nil {
			fmt.Fprintln(os.Stderr, "worker output:", err)
		}
	}
	send(map[string]bool{"ready": true})
	var work sync.WaitGroup
	var activeMu sync.Mutex
	active := make(map[uint64]context.CancelFunc)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64<<10), maxBodyBytes)
	for scanner.Scan() {
		var message requestMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			return fmt.Errorf("invalid worker message: %w", err)
		}
		if message.Type == "cancel" {
			activeMu.Lock()
			if cancel := active[message.ID]; cancel != nil {
				cancel()
			}
			activeMu.Unlock()
			continue
		}
		if message.Type != "request" || message.ID == 0 {
			return errors.New("invalid request message")
		}
		ctx, cancel := context.WithCancel(context.Background())
		activeMu.Lock()
		active[message.ID] = cancel
		activeMu.Unlock()
		work.Add(1)
		go func(message requestMessage) {
			defer work.Done()
			defer func() { cancel(); activeMu.Lock(); delete(active, message.ID); activeMu.Unlock() }()
			send(execute(ctx, client, message))
		}(message)
	}
	// EOF llega al cerrar stdin desde Node: cancela también las descargas activas.
	activeMu.Lock()
	for _, cancel := range active {
		cancel()
	}
	activeMu.Unlock()
	work.Wait()
	return scanner.Err()
}

func newSession(transport http.RoundTripper, timeout time.Duration) (*http.Client, error) {
	jar, err := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: transport, Jar: jar, Timeout: timeout}, nil
}

// Go quita Content-Encoding cuando ya ha descomprimido gzip automáticamente.
// Los encodings que permanecen requieren decodificación explícita.
func readResponseBody(response *http.Response) ([]byte, error) {
	var reader io.Reader = response.Body
	encodings := strings.Split(strings.Join(response.Header.Values("Content-Encoding"), ","), ",")
	for index := len(encodings) - 1; index >= 0; index-- {
		switch encoding := strings.ToLower(strings.TrimSpace(encodings[index])); encoding {
		case "", "identity":
		case "gzip":
			decoder, err := gzip.NewReader(reader)
			if err != nil {
				return nil, err
			}
			defer decoder.Close()
			reader = decoder
		case "deflate":
			decoder, err := zlib.NewReader(reader)
			if err != nil {
				return nil, err
			}
			defer decoder.Close()
			reader = decoder
		case "br":
			reader = brotli.NewReader(reader)
		case "zstd":
			decoder, err := zstd.NewReader(reader,
				zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(32<<20), zstd.WithDecoderMaxWindow(maxBodyBytes))
			if err != nil {
				return nil, err
			}
			defer decoder.Close()
			reader = decoder
		default:
			return nil, fmt.Errorf("unsupported Content-Encoding: %s", encoding)
		}
	}
	body, err := io.ReadAll(io.LimitReader(reader, maxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxBodyBytes {
		return nil, errors.New("response exceeds 16 MiB limit")
	}
	if response.Header.Get("Content-Encoding") != "" {
		response.Header.Del("Content-Encoding")
		response.Header.Del("Content-Length")
	}
	return body, nil
}

func execute(ctx context.Context, session *http.Client, message requestMessage) responseMessage {
	result := responseMessage{ID: message.ID}
	if message.Method != "GET" && message.Method != "POST" {
		result.Error = "unsupported method"
		return result
	}
	req, err := http.NewRequestWithContext(ctx, message.Method, message.URL, strings.NewReader(message.Body))
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
		result.Error = "only HTTP and HTTPS URLs are supported"
		return result
	}
	for name, value := range message.Headers {
		req.Header.Set(name, value)
	}
	// Host es un campo especial en net/http.
	if host := req.Header.Get("Host"); host != "" {
		req.Host = host
		req.Header.Del("Host")
	}
	client := *session
	client.CheckRedirect = func(_ *http.Request, via []*http.Request) error {
		switch message.Redirect {
		case "manual":
			return http.ErrUseLastResponse
		case "error":
			return errors.New("redirect not allowed")
		}
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		return nil
	}
	response, err := client.Do(req)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer response.Body.Close()
	body, err := readResponseBody(response)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Status = response.StatusCode
	result.Headers = response.Header
	result.Body = body
	result.URL = response.Request.URL.String()
	result.Protocol = response.Proto
	return result
}
