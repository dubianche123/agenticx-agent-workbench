package server

import (
	"encoding/json"
	"testing"

	"github.com/agenticx/enterprise/gateway/internal/audit"
	"github.com/agenticx/enterprise/gateway/internal/channel"
	"github.com/agenticx/enterprise/gateway/internal/openai"
)

func TestEnrichAuditRoutingPolicy(t *testing.T) {
	ev := audit.Event{ID: "ev1"}
	decision := channel.PickDecision{
		ChannelID: "ch-fast",
		Policy:    channel.LBLatencyAware,
		Reason:    "latency",
	}
	enrichAuditRoutingPolicy(&ev, decision)
	if len(ev.RoutingPolicy) == 0 {
		t.Fatal("expected routing_policy on audit event")
	}
	var got channel.PickDecision
	if err := json.Unmarshal(ev.RoutingPolicy, &got); err != nil {
		t.Fatalf("unmarshal routing_policy: %v", err)
	}
	if got.ChannelID != "ch-fast" || got.Policy != channel.LBLatencyAware || got.Reason != "latency" {
		t.Fatalf("unexpected routing_policy: %+v", got)
	}
}

func TestEnrichAuditRoutingPolicySkipsEmpty(t *testing.T) {
	ev := audit.Event{ID: "ev2"}
	enrichAuditRoutingPolicy(&ev, channel.PickDecision{})
	if len(ev.RoutingPolicy) != 0 {
		t.Fatalf("expected empty routing_policy, got %s", string(ev.RoutingPolicy))
	}
}

func TestEnrichAuditFinishReasonPreservesRoutingPolicy(t *testing.T) {
	ev := audit.Event{ID: "ev3"}
	enrichAuditRoutingPolicy(&ev, channel.PickDecision{
		ChannelID: "ch-fast",
		Policy:    channel.LBLatencyAware,
		Reason:    "latency",
	})
	enrichAuditFinishReason(&ev, "length")

	var got map[string]any
	if err := json.Unmarshal(ev.RoutingPolicy, &got); err != nil {
		t.Fatalf("unmarshal routing_policy: %v", err)
	}
	if got["channel_id"] != "ch-fast" || got["reason"] != "latency" {
		t.Fatalf("routing policy was not preserved: %+v", got)
	}
	if got[modelFinishReasonMetadataKey] != "length" || got[modelFinishReasonClassMetadataKey] != "length" {
		t.Fatalf("finish reason metadata missing: %+v", got)
	}
}

func TestEnrichAuditFinishReasonWithoutRoutingPolicy(t *testing.T) {
	ev := audit.Event{ID: "ev4"}
	enrichAuditFinishReason(&ev, "stop")

	var got map[string]any
	if err := json.Unmarshal(ev.RoutingPolicy, &got); err != nil {
		t.Fatalf("unmarshal routing_policy: %v", err)
	}
	if got[modelFinishReasonMetadataKey] != "stop" || got[modelFinishReasonClassMetadataKey] != "stop" {
		t.Fatalf("finish reason metadata missing: %+v", got)
	}
}

func TestStreamFinishReasonPrefersLatestPrimaryChoice(t *testing.T) {
	tracker := streamFinishReason{}
	stop := "stop"
	length := "length"
	tracker.observe(openai.StreamChunk{
		Choices: []openai.StreamChoice{{Index: 0, FinishReason: &stop}},
	})
	tracker.observe(openai.StreamChunk{
		Choices: []openai.StreamChoice{{Index: 1, FinishReason: &length}},
	})
	if got := tracker.value(); got != "stop" {
		t.Fatalf("expected primary choice finish reason, got %q", got)
	}
	tracker.observe(openai.StreamChunk{
		Choices: []openai.StreamChoice{{Index: 0, FinishReason: &length}},
	})
	if got := tracker.value(); got != "length" {
		t.Fatalf("expected latest primary finish reason, got %q", got)
	}
}

func TestAddFinishReasonMetadataClassifiesStopAndLength(t *testing.T) {
	for reason, wantClass := range map[string]string{
		"stop":       "stop",
		"length":     "length",
		"max_tokens": "length",
	} {
		meta := map[string]any{}
		addFinishReasonMetadata(meta, reason)
		if meta[modelFinishReasonMetadataKey] != reason {
			t.Fatalf("model finish reason=%v, want %q", meta[modelFinishReasonMetadataKey], reason)
		}
		if meta[modelFinishReasonClassMetadataKey] != wantClass {
			t.Fatalf("model finish reason class=%v, want %q", meta[modelFinishReasonClassMetadataKey], wantClass)
		}
	}
}
