package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agenticx/enterprise/gateway/internal/adaptor"
	"github.com/agenticx/enterprise/gateway/internal/attachment"
	"github.com/agenticx/enterprise/gateway/internal/audit"
	"github.com/agenticx/enterprise/gateway/internal/channel"
	"github.com/agenticx/enterprise/gateway/internal/metering"
	"github.com/agenticx/enterprise/gateway/internal/openai"
	"github.com/agenticx/enterprise/gateway/internal/quota"
	"github.com/agenticx/enterprise/gateway/internal/relay"
	"github.com/agenticx/enterprise/gateway/internal/routing"
	policyengine "github.com/agenticx/enterprise/policy-engine"
)

type attachmentPolicyStub struct {
	allowed bool
	err     error
	calls   int
}

func (s *attachmentPolicyStub) AllowPublicOverride(_ context.Context, _ attachment.Identity) (bool, error) {
	s.calls++
	return s.allowed, s.err
}

type attachmentAuditWriter struct {
	events []audit.Event
	err    error
}

type attachmentNoopMeterSink struct{}

func (attachmentNoopMeterSink) ReportAsync(metering.UsageRecord) {}

func (w *attachmentAuditWriter) Write(event *audit.Event) error {
	if w.err != nil {
		return w.err
	}
	if event == nil {
		return errors.New("nil audit event")
	}
	w.events = append(w.events, *event)
	return nil
}

func newAttachmentRoutingTestServer(policy *attachmentPolicyStub, writer *attachmentAuditWriter) *Server {
	return &Server{
		logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		audit:            writer,
		attachmentPolicy: policy,
	}
}

func attachmentRoutingRequest(marker string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set(HeaderAttachmentRoute, marker)
	return req
}

func attachmentRoutingIdentity() requestIdentity {
	return requestIdentity{
		TenantID:     "tenant-1",
		UserID:       "user-1",
		UserEmail:    "user@example.invalid",
		DepartmentID: "dept-1",
		SessionID:    "session-1",
		TraceID:      "trace-1",
		ClientType:   "web-portal",
	}
}

func TestAttachmentRoutingGatewayAuditsAcceptedPublicDecisionOnce(t *testing.T) {
	policy := &attachmentPolicyStub{allowed: true}
	writer := &attachmentAuditWriter{}
	s := newAttachmentRoutingTestServer(policy, writer)
	req := attachmentRoutingRequest("public-override")
	rec := httptest.NewRecorder()

	if ok := s.enforceAttachmentRouting(
		rec,
		req,
		attachmentRoutingIdentity(),
		routing.Decision{Route: "third-party", Provider: "glm", Model: "glm-5.2"},
		"glm-5.2",
		time.Now(),
	); !ok {
		t.Fatalf("authorized public route was rejected: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if policy.calls != 1 {
		t.Fatalf("policy calls=%d, want 1", policy.calls)
	}
	if len(writer.events) != 1 {
		t.Fatalf("audit events=%d, want exactly one", len(writer.events))
	}
	if got := writer.events[0].EventType; got != "attachment_routing.public_override" {
		t.Fatalf("event type=%q, want accepted public override event", got)
	}
	var detail map[string]any
	if err := json.Unmarshal(writer.events[0].RoutingPolicy, &detail); err != nil {
		t.Fatalf("decode routing policy: %v", err)
	}
	if got := detail["decision"]; got != "public_override" {
		t.Fatalf("routing decision=%v, want public_override", got)
	}
	if got := detail["route"]; got != "third-party" {
		t.Fatalf("routing route=%v, want third-party", got)
	}
}

func TestAttachmentRoutingGatewayDenialDoesNotWriteAcceptedEvent(t *testing.T) {
	policy := &attachmentPolicyStub{}
	writer := &attachmentAuditWriter{}
	s := newAttachmentRoutingTestServer(policy, writer)
	req := attachmentRoutingRequest("public-override")
	rec := httptest.NewRecorder()

	if ok := s.enforceAttachmentRouting(
		rec,
		req,
		attachmentRoutingIdentity(),
		routing.Decision{Route: "third-party", Provider: "glm", Model: "glm-5.2"},
		"glm-5.2",
		time.Now(),
	); ok {
		t.Fatal("unauthorized public route was accepted")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403 body=%s", rec.Code, rec.Body.String())
	}
	if len(writer.events) != 1 {
		t.Fatalf("audit events=%d, want exactly one denial", len(writer.events))
	}
	if got := writer.events[0].EventType; got != "attachment_routing.public_override_denied" {
		t.Fatalf("event type=%q, want denial event", got)
	}
}

func TestAttachmentRoutingGatewayPolicyFailureIsDeniedAndAudited(t *testing.T) {
	policy := &attachmentPolicyStub{err: errors.New("database unavailable")}
	writer := &attachmentAuditWriter{}
	s := newAttachmentRoutingTestServer(policy, writer)
	req := attachmentRoutingRequest("public-override")
	rec := httptest.NewRecorder()

	if ok := s.enforceAttachmentRouting(
		rec,
		req,
		attachmentRoutingIdentity(),
		routing.Decision{Route: "third-party", Provider: "glm", Model: "glm-5.2"},
		"glm-5.2",
		time.Now(),
	); ok {
		t.Fatal("policy failure must not permit a public route")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if len(writer.events) != 1 || writer.events[0].EventType != "attachment_routing.public_override_denied" {
		t.Fatalf("audit events=%v, want one denied event", writer.events)
	}
}

func TestAttachmentRoutingGatewayMissingPolicyIsDeniedAndAudited(t *testing.T) {
	writer := &attachmentAuditWriter{}
	s := newAttachmentRoutingTestServer(&attachmentPolicyStub{}, writer)
	s.attachmentPolicy = nil
	req := attachmentRoutingRequest("public-override")
	rec := httptest.NewRecorder()

	if ok := s.enforceAttachmentRouting(
		rec,
		req,
		attachmentRoutingIdentity(),
		routing.Decision{Route: "third-party", Provider: "glm", Model: "glm-5.2"},
		"glm-5.2",
		time.Now(),
	); ok {
		t.Fatal("missing policy must not permit a public route")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if len(writer.events) != 1 || writer.events[0].EventType != "attachment_routing.public_override_denied" {
		t.Fatalf("audit events=%v, want one denied event", writer.events)
	}
}

func TestAttachmentRoutingPrivateRouteDenialFailsClosedWhenAuditFails(t *testing.T) {
	writer := &attachmentAuditWriter{err: errors.New("audit unavailable")}
	s := newAttachmentRoutingTestServer(nil, writer)
	req := attachmentRoutingRequest("private")
	rec := httptest.NewRecorder()

	if ok := s.enforceAttachmentRouting(
		rec,
		req,
		attachmentRoutingIdentity(),
		routing.Decision{Route: "third-party", Provider: "glm", Model: "glm-5.2"},
		"glm-5.2",
		time.Now(),
	); ok {
		t.Fatal("private route mismatch must be rejected")
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500 when denial audit fails; body=%s", rec.Code, rec.Body.String())
	}
}

func TestAttachmentRoutingPublicRouteDenialFailsClosedWhenAuditFails(t *testing.T) {
	writer := &attachmentAuditWriter{err: errors.New("audit unavailable")}
	s := newAttachmentRoutingTestServer(nil, writer)
	req := attachmentRoutingRequest("public-override")
	rec := httptest.NewRecorder()

	if ok := s.enforceAttachmentRouting(
		rec,
		req,
		attachmentRoutingIdentity(),
		routing.Decision{Route: "local", Provider: "ollama", Model: "llama3"},
		"llama3",
		time.Now(),
	); ok {
		t.Fatal("public route mismatch must be rejected")
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500 when denial audit fails; body=%s", rec.Code, rec.Body.String())
	}
}

func TestAttachmentRoutingInvalidMarkerIsAuditedOnce(t *testing.T) {
	writer := &attachmentAuditWriter{}
	s := newAttachmentRoutingTestServer(nil, writer)
	req := attachmentRoutingRequest("unexpected")
	rec := httptest.NewRecorder()

	if ok := s.enforceAttachmentRouting(
		rec,
		req,
		attachmentRoutingIdentity(),
		routing.Decision{Route: "third-party", Provider: "glm", Model: "glm-5.2"},
		"glm-5.2",
		time.Now(),
	); ok {
		t.Fatal("invalid marker must be rejected")
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if len(writer.events) != 1 || writer.events[0].EventType != "attachment_routing.invalid_marker" {
		t.Fatalf("audit events=%v, want one invalid-marker event", writer.events)
	}
}

func TestAttachmentRoutingRelayUsesActualPrivateChannelInFinalAudit(t *testing.T) {
	var privateHits, publicHits atomic.Int32
	privateUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		privateHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "private-response",
			"choices": []map[string]any{{
				"message": map[string]any{"role": "assistant", "content": "private"},
			}},
		})
	}))
	defer privateUpstream.Close()
	publicUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		publicHits.Add(1)
		http.Error(w, "wrong route", http.StatusInternalServerError)
	}))
	defer publicUpstream.Close()

	registry := channel.NewRegistry(nil, nil)
	registry.SetSnapshot([]channel.Channel{
		{ID: "public", TenantID: "tenant-1", Route: "third-party", ProviderLabel: "public-provider", BaseURL: publicUpstream.URL, APIKey: "public-key", Weight: 100, Status: channel.StatusActive, SupportedModels: []string{"m"}},
		{ID: "private", TenantID: "tenant-1", Route: "local", ProviderLabel: "private-provider", BaseURL: privateUpstream.URL, APIKey: "private-key", Weight: 1, Status: channel.StatusActive, SupportedModels: []string{"m"}},
	})
	exec := relay.NewExecutor(
		channel.NewPicker(registry, channel.NewStatsStore(), channel.NewAffinityStore(0)),
		adaptor.NewFactory(adaptor.NewOpenAIAdaptor()),
		nil,
	)

	writer := &attachmentAuditWriter{}
	s := newAttachmentRoutingTestServer(nil, writer)
	s.relayExecutor = exec
	s.policy = &policyengine.Engine{}
	s.metering = attachmentNoopMeterSink{}
	req := attachmentRoutingRequest("private")
	identity := attachmentRoutingIdentity()
	initial := routing.Decision{Route: "local", Provider: "initial-provider", Model: "m"}
	if ok := s.enforceAttachmentRouting(httptest.NewRecorder(), req, identity, initial, "m", time.Now()); !ok {
		t.Fatal("private marker should pass initial private decision")
	}

	rec := httptest.NewRecorder()
	s.handleChatCompleteRelay(
		rec,
		req,
		openai.ChatCompletionRequest{Model: "m", Messages: []openai.ChatMessage{{Role: "user", Content: openai.NewStringContent("hello")}}},
		time.Now(),
		identity,
		1,
		1,
		nil,
		quota.CheckResult{},
		initial,
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if privateHits.Load() != 1 || publicHits.Load() != 0 {
		t.Fatalf("upstream hits private=%d public=%d", privateHits.Load(), publicHits.Load())
	}
	if len(writer.events) != 2 {
		t.Fatalf("audit events=%d, want one routing + one final call: %+v", len(writer.events), writer.events)
	}
	final := writer.events[1]
	if final.EventType != "chat_call" || final.Provider != "private-provider" || final.Route != "local" || final.ChannelID != "private" {
		t.Fatalf("final audit=%+v, want actual private channel", final)
	}
}
