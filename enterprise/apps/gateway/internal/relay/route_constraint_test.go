package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/agenticx/enterprise/gateway/internal/adaptor"
	"github.com/agenticx/enterprise/gateway/internal/channel"
	"github.com/agenticx/enterprise/gateway/internal/openai"
)

func routeConstraintResponse(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(openai.ChatCompletionResponse{
		ID: "route-test",
		Choices: []openai.ChatCompletionChoice{{
			Message: openai.ChatMessage{Role: "assistant", Content: openai.NewStringContent("ok")},
		}},
	})
}

func newRouteConstraintExecutor(channels []channel.Channel) *Executor {
	reg := channel.NewRegistry(nil, nil)
	reg.SetSnapshot(channels)
	picker := channel.NewPicker(reg, channel.NewStatsStore(), channel.NewAffinityStore(0))
	return NewExecutor(picker, adaptor.NewFactory(adaptor.NewOpenAIAdaptor()), nil)
}

func routeConstraintRequest() openai.ChatCompletionRequest {
	return openai.ChatCompletionRequest{
		Model:    "m",
		Messages: []openai.ChatMessage{{Role: "user", Content: openai.NewStringContent("route")}},
	}
}

func TestCompleteWithRouteNeverRetriesAcrossRouteClasses(t *testing.T) {
	var privateHits, publicHits atomic.Int32
	privateUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		privateHits.Add(1)
		http.Error(w, "private unavailable", http.StatusServiceUnavailable)
	}))
	defer privateUpstream.Close()
	publicUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		publicHits.Add(1)
		routeConstraintResponse(w, nil)
	}))
	defer publicUpstream.Close()

	exec := newRouteConstraintExecutor([]channel.Channel{
		{
			ID: "public", TenantID: "t1", Route: "third-party", ProviderLabel: "public",
			BaseURL: publicUpstream.URL, APIKey: "public-key", Weight: 100,
			Status: channel.StatusActive, SupportedModels: []string{"m"},
		},
		{
			ID: "private", TenantID: "t1", Route: "local", ProviderLabel: "private",
			BaseURL: privateUpstream.URL, APIKey: "private-key", Weight: 1,
			Status: channel.StatusActive, SupportedModels: []string{"m"},
		},
	})

	result, err := exec.CompleteWithRoute(
		context.Background(),
		routeConstraintRequest(),
		"m",
		channel.Identity{TenantID: "t1"},
		"private",
	)
	if err == nil {
		t.Fatal("private upstream failure must be returned when no private fallback exists")
	}
	if result.Channel.ID != "private" {
		t.Fatalf("failed execution channel=%q, want private", result.Channel.ID)
	}
	if got := privateHits.Load(); got == 0 {
		t.Fatal("expected private upstream to be attempted")
	}
	if got := publicHits.Load(); got != 0 {
		t.Fatalf("public upstream must not be called by private route retry, hits=%d", got)
	}
}

func TestCompleteWithRouteSelectsOnlyPublicCandidate(t *testing.T) {
	var privateHits, publicHits atomic.Int32
	privateUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		privateHits.Add(1)
		http.Error(w, "wrong route", http.StatusInternalServerError)
	}))
	defer privateUpstream.Close()
	publicUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		publicHits.Add(1)
		routeConstraintResponse(w, r)
	}))
	defer publicUpstream.Close()

	exec := newRouteConstraintExecutor([]channel.Channel{
		{ID: "private", TenantID: "t1", Route: "private-cloud", ProviderLabel: "private", BaseURL: privateUpstream.URL, APIKey: "private-key", Weight: 100, Status: channel.StatusActive, SupportedModels: []string{"m"}},
		{ID: "public", TenantID: "t1", Route: "third-party", ProviderLabel: "public", BaseURL: publicUpstream.URL, APIKey: "public-key", Weight: 1, Status: channel.StatusActive, SupportedModels: []string{"m"}},
	})

	result, err := exec.CompleteWithRoute(context.Background(), routeConstraintRequest(), "m", channel.Identity{TenantID: "t1"}, "third-party")
	if err != nil {
		t.Fatalf("public candidate should succeed: %v", err)
	}
	if result.Channel.ID != "public" || result.Channel.Route != "third-party" {
		t.Fatalf("selected channel=%+v, want public third-party", result.Channel)
	}
	if publicHits.Load() != 1 {
		t.Fatalf("public upstream hits=%d, want 1", publicHits.Load())
	}
	if privateHits.Load() != 0 {
		t.Fatalf("private upstream must not be called for public override, hits=%d", privateHits.Load())
	}
}

func TestStreamWithRouteReturnsNoCandidateWithoutCallingWrongUpstream(t *testing.T) {
	var publicHits atomic.Int32
	publicUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		publicHits.Add(1)
		http.Error(w, "wrong route", http.StatusInternalServerError)
	}))
	defer publicUpstream.Close()

	exec := newRouteConstraintExecutor([]channel.Channel{
		{ID: "public", TenantID: "t1", Route: "third-party", ProviderLabel: "public", BaseURL: publicUpstream.URL, APIKey: "public-key", Weight: 1, Status: channel.StatusActive, SupportedModels: []string{"m"}},
	})
	_, err := exec.StreamWithRoute(
		context.Background(),
		routeConstraintRequest(),
		"m",
		channel.Identity{TenantID: "t1"},
		"private",
		func(openai.StreamChunk) error { return nil },
	)
	if err == nil {
		t.Fatal("missing private candidate must be an error")
	}
	if !strings.Contains(err.Error(), "no channel for model") {
		t.Fatalf("unexpected error: %v", err)
	}
	if publicHits.Load() != 0 {
		t.Fatalf("wrong-route upstream must not be called, hits=%d", publicHits.Load())
	}
}
