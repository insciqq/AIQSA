package state

import "testing"

func TestKindsAreValidAndDistinct(t *testing.T) {
	seen := map[Kind]bool{}
	for _, kind := range Kinds {
		if !kind.Valid() || seen[kind] {
			t.Fatalf("kind %q invalid or repeated", kind)
		}
		seen[kind] = true
	}
	if len(Kinds) != 8 {
		t.Fatalf("got %d kinds", len(Kinds))
	}
	if Kind("asleep").Valid() || Kind("").Valid() {
		t.Fatal("an unknown kind is valid")
	}
}

func TestSinkReport(t *testing.T) {
	var nilSink Sink
	nilSink.Report(State{Kind: Connected}) // must not panic

	var got []State
	sink := Sink(func(state State) { got = append(got, state) })
	sink.Report(State{Kind: Pairing, Origin: "https://ai.example.test", UserCode: "BCDF-2345", VerificationURI: "https://ai.example.test/connect/pair?code=BCDF-2345"})
	sink.Report(State{Kind: Connected, Origin: "https://ai.example.test"})
	if len(got) != 2 || got[0].Kind != Pairing || got[0].UserCode != "BCDF-2345" || got[1].Kind != Connected || got[1].UserCode != "" {
		t.Fatalf("got %+v", got)
	}
}
