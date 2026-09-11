package provider

import (
	"strings"
	"testing"
	"time"

	"github.com/agenticx/enterprise/gateway/internal/openai"
)

func TestParseSSEStreamPreservesFinalFinishReason(t *testing.T) {
	body := strings.NewReader(
		"data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n" +
			"data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n" +
			"data: [DONE]\n\n",
	)
	var chunks []openai.StreamChunk
	if err := parseSSEStream(body, time.Second, func(chunk openai.StreamChunk) error {
		chunks = append(chunks, chunk)
		return nil
	}); err != nil {
		t.Fatalf("parseSSEStream returned error: %v", err)
	}
	if len(chunks) != 2 {
		t.Fatalf("expected content and final chunks, got %d", len(chunks))
	}
	finish := chunks[len(chunks)-1].Choices[0].FinishReason
	if finish == nil || *finish != "length" {
		t.Fatalf("expected final finish_reason length, got %+v", finish)
	}
}
