import { describe, expect, it } from "vitest";
import {
  decodeAdminSpeechToTextModels,
  decodeAdminSpeechToTextResponse,
  decodeCatalogDictation,
  decodeTranscriptionResponse,
  dictationAudioMimeType
} from "./speechToText";

describe("speech to text contracts", () => {
  it("allowlists recorder formats by base type", () => {
    expect(dictationAudioMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(dictationAudioMimeType("Audio/MP4")).toBe("audio/mp4");
    expect(dictationAudioMimeType("audio/x-wav")).toBe("audio/wav");
    expect(dictationAudioMimeType("video/webm")).toBeNull();
    expect(dictationAudioMimeType("")).toBeNull();
  });

  it("decodes the catalog flag strictly", () => {
    expect(decodeCatalogDictation({ available: true, unavailableReason: null })).toEqual({ available: true, unavailableReason: null });
    expect(decodeCatalogDictation({ available: false, unavailableReason: "not_configured" })).toEqual({ available: false, unavailableReason: "not_configured" });
    expect(decodeCatalogDictation({ available: true, unavailableReason: "unavailable" })).toBeNull();
    expect(decodeCatalogDictation({ available: false, unavailableReason: null })).toBeNull();
    expect(decodeCatalogDictation("yes")).toBeNull();
  });

  it("decodes a transcript and bounds it", () => {
    expect(decodeTranscriptionResponse({ text: "hi" })).toEqual({ text: "hi" });
    expect(decodeTranscriptionResponse({ text: "x".repeat(64_001) })).toBeNull();
    expect(decodeTranscriptionResponse({})).toBeNull();
  });

  it("decodes the administrator role and its candidates", () => {
    const role = { configuredAt: "2026-10-08T10:00:00.000Z", connections: [{ displayName: "OpenRouter", family: "openrouter", id: "c1", ready: true }],
      assignment: { available: false, connectionDisplayName: null, connectionId: "c1", modelId: "openai/whisper-1", unavailableReason: "verification_required" } };
    expect(decodeAdminSpeechToTextResponse({ speechToText: role })).toEqual(role);
    expect(decodeAdminSpeechToTextResponse({ speechToText: { ...role, assignment: { ...role.assignment, available: true } } })).toBeNull();
    expect(decodeAdminSpeechToTextResponse({ speechToText: { ...role, connections: [{ ...role.connections[0], family: "anthropic" }] } })).toBeNull();
    expect(decodeAdminSpeechToTextModels({ models: ["whisper-1"] })).toEqual(["whisper-1"]);
    expect(decodeAdminSpeechToTextModels({ models: [" whisper"] })).toBeNull();
  });
});
