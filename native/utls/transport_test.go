package main

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

func TestSessionRejectsPublicSuffixCookies(t *testing.T) {
	session, err := newSession(nil, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := url.Parse("https://a.co.uk/")
	other, _ := url.Parse("https://b.co.uk/")
	session.Jar.SetCookies(first, []*http.Cookie{
		{Name: "cross-site", Value: "blocked", Domain: "co.uk", Path: "/"},
		{Name: "own", Value: "allowed", Domain: "a.co.uk", Path: "/"},
	})
	if cookies := session.Jar.Cookies(other); len(cookies) != 0 {
		t.Fatalf("public-suffix cookie leaked to unrelated site: %v", cookies)
	}
	if cookies := session.Jar.Cookies(first); len(cookies) != 1 || cookies[0].Value != "allowed" {
		t.Fatalf("own-domain cookie not preserved: %v", cookies)
	}
}

func TestTransportTLS(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		t.Run(map[bool]string{false: "HTTP1", true: "HTTP2"}[h2], func(t *testing.T) {
			var mu sync.Mutex
			ports := []string{}
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				ports = append(ports, r.RemoteAddr)
				mu.Unlock()
				w.Write([]byte(r.Proto))
			}))
			server.EnableHTTP2 = h2
			server.StartTLS()
			defer server.Close()
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			transport, err := newTransport("chrome", roots)
			if err != nil {
				t.Fatal(err)
			}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport}
			want := "HTTP/1.1"
			if h2 {
				want = "HTTP/2.0"
			}
			for range 2 {
				response, err := client.Get(server.URL)
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(response.Body)
				response.Body.Close()
				if err != nil || string(body) != want {
					t.Fatalf("protocol = %s, err = %v", body, err)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if len(ports) != 2 || ports[0] != ports[1] {
				t.Fatalf("connection not reused: %v", ports)
			}
		})
	}
}

func TestTLSVerificationAndProfiles(t *testing.T) {
	var curves []tls.CurveID
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) }))
	server.TLS = &tls.Config{GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		curves = append([]tls.CurveID{}, hello.SupportedCurves...)
		return nil, nil
	}}
	server.StartTLS()
	defer server.Close()
	untrusted, _ := newTransport("chrome", nil)
	defer untrusted.CloseIdleConnections()
	if response, err := (&http.Client{Transport: untrusted}).Get(server.URL); err == nil {
		response.Body.Close()
		t.Fatal("untrusted certificate accepted")
	}
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	for _, profile := range []string{"chrome", "firefox", "safari", "ios"} {
		transport, err := newTransport(profile, roots)
		if err != nil {
			t.Fatal(err)
		}
		response, err := (&http.Client{Transport: transport}).Get(server.URL)
		if err != nil {
			t.Fatalf("%s: %v", profile, err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		transport.CloseIdleConnections()
		if profile == "chrome" {
			grease := false
			for _, curve := range curves {
				if uint16(curve)&0x0f0f == 0x0a0a {
					grease = true
				}
			}
			if !grease {
				t.Fatal("Chrome ClientHello has no GREASE")
			}
		}
	}
	if _, err := newTransport("unknown", roots); err == nil {
		t.Fatal("unsupported profile accepted")
	}
}
