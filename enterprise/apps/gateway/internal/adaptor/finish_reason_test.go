package adaptor

import (
	"strings"
	"testing"

	"github.com/agenticx/enterprise/gateway/internal/openai"
)

func TestParseClaudeSSEPreservesLengthFinishReason(t *testing.T) {
	var chunks []openai.StreamChunk
	body := strings.NewReader("event: content_block_delta\n" +
		"data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"partial\"}}\n\n" +
		"event: message_delta\n" +
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n" +
		"event: message_stop\n" +
		"data: {\"type\":\"message_stop\"}\n\n")
	if err := parseClaudeSSE(body, "claude", func(chunk openai.StreamChunk) error {
		chunks = append(chunks, chunk)
		return nil
	}); err != nil {
		t.Fatalf("parseClaudeSSE returned error: %v", err)
	}
	if len(chunks) != 2 {
		t.Fatalf("expected content and final chunks, got %d", len(chunks))
	}
	final := chunks[len(chunks)-1]
	if final.Choices[0].FinishReason == nil || *final.Choices[0].FinishReason != "length" {
		t.Fatalf("expected length finish reason, got %+v", final.Choices[0].FinishReason)
	}
}

func TestParseGeminiSSEEmitsFinalFinishReason(t *testing.T) {
	var chunks []openai.StreamChunk
	body := strings.NewReader(
		"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]}}]}\n\n" +
			"data: {\"candidates\":[{\"finishReason\":\"MAX_TOKENS\"}]}\n\n",
	)
	if err := parseGeminiSSE(body, "gemini", func(chunk openai.StreamChunk) error {
		chunks = append(chunks, chunk)
		return nil
	}); err != nil {
		t.Fatalf("parseGeminiSSE returned error: %v", err)
	}
	if len(chunks) != 2 {
		t.Fatalf("expected content and final chunks, got %d", len(chunks))
	}
	final := chunks[len(chunks)-1]
	if final.Choices[0].FinishReason == nil || *final.Choices[0].FinishReason != "length" {
		t.Fatalf("expected length finish reason, got %+v", final.Choices[0].FinishReason)
	}
}

func TestGeminiFinishReasonMapping(t *testing.T) {
	for raw, want := range map[string]string{
		"STOP":       "stop",
		"MAX_TOKENS": "length",
		"SAFETY":     "safety",
	} {
		if got := geminiFinishReason(raw); got != want {
			t.Fatalf("geminiFinishReason(%q)=%q, want %q", raw, got, want)
		}
	}
}
