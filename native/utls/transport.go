package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

// uTLS construye ClientHello. HTTP/1.1 y HTTP/2 conservan sus propios pools.
type browserTransport struct {
	profile utls.ClientHelloID
	roots   *x509.CertPool
	plain   *http.Transport
	mu      sync.Mutex
	origins map[string]*originTransport
}
type originTransport struct {
	mu        sync.Mutex
	first     net.Conn
	transport http.RoundTripper
}

func newTransport(profile string, roots *x509.CertPool) (*browserTransport, error) {
	profiles := map[string]utls.ClientHelloID{
		"chrome":  utls.HelloChrome_Auto,
		"firefox": utls.HelloFirefox_Auto,
		"safari":  utls.HelloSafari_Auto,
		"ios":     utls.HelloIOS_Auto,
	}
	hello, ok := profiles[profile]
	if !ok {
		return nil, fmt.Errorf("unsupported TLS profile: %s", profile)
	}
	return &browserTransport{
		profile: hello, roots: roots, origins: make(map[string]*originTransport),
		plain: &http.Transport{IdleConnTimeout: 90 * time.Second, MaxIdleConns: 100},
	}, nil
}

func (t *browserTransport) dialTLS(ctx context.Context, network, address string) (*utls.UConn, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	raw, err := (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, address)
	if err != nil {
		return nil, err
	}
	conn := utls.UClient(raw, &utls.Config{ServerName: host, RootCAs: t.roots}, t.profile)
	if err := conn.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, err
	}
	return conn, nil
}

func (t *browserTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme == "http" {
		return t.plain.RoundTrip(req)
	}
	if req.URL.Scheme != "https" {
		return nil, fmt.Errorf("only HTTP and HTTPS URLs are supported")
	}
	address := net.JoinHostPort(req.URL.Hostname(), req.URL.Port())
	if req.URL.Port() == "" {
		address = net.JoinHostPort(req.URL.Hostname(), "443")
	}
	t.mu.Lock()
	origin := t.origins[address]
	if origin == nil {
		origin = &originTransport{}
		t.origins[address] = origin
	}
	t.mu.Unlock()

	origin.mu.Lock()
	if origin.transport == nil {
		first, err := t.dialTLS(req.Context(), "tcp", address)
		if err != nil {
			origin.mu.Unlock()
			return nil, err
		}
		origin.first = first
		protocol := first.ConnectionState().NegotiatedProtocol
		dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
			origin.mu.Lock()
			if origin.first != nil {
				conn := origin.first
				origin.first = nil
				origin.mu.Unlock()
				if err := ctx.Err(); err != nil {
					conn.Close()
					return nil, err
				}
				return conn, nil
			}
			origin.mu.Unlock()
			conn, err := t.dialTLS(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			if conn.ConnectionState().NegotiatedProtocol != protocol {
				conn.Close()
				return nil, fmt.Errorf("server changed its negotiated ALPN protocol")
			}
			return conn, nil
		}
		if protocol == "h2" {
			origin.transport = &http2.Transport{
				IdleConnTimeout: 90 * time.Second,
				DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
					return dial(ctx, network, addr)
				},
			}
		} else if protocol == "" || protocol == "http/1.1" {
			origin.transport = &http.Transport{
				DialTLSContext: dial, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 100,
			}
		} else {
			first.Close()
			origin.first = nil
			origin.mu.Unlock()
			return nil, fmt.Errorf("unsupported ALPN protocol: %s", protocol)
		}
	}
	transport := origin.transport
	origin.mu.Unlock()
	return transport.RoundTrip(req)
}

func (t *browserTransport) CloseIdleConnections() {
	t.plain.CloseIdleConnections()
	t.mu.Lock()
	origins := make([]*originTransport, 0, len(t.origins))
	for _, origin := range t.origins {
		origins = append(origins, origin)
	}
	t.mu.Unlock()
	for _, origin := range origins {
		origin.mu.Lock()
		if origin.first != nil {
			origin.first.Close()
			origin.first = nil
		}
		transport := origin.transport
		origin.mu.Unlock()
		if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
			closer.CloseIdleConnections()
		}
	}
}
