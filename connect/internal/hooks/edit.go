package hooks

import (
	"encoding/json"
	"errors"
	"slices"

	"github.com/insciqq/AIQSA/connect/internal/status"
)

var errEventNotArray = errors.New("hook event is not an array")

func (o *object) keys() []string {
	keys := make([]string, 0, len(o.members))
	for _, m := range o.members {
		if !slices.Contains(keys, m.key) {
			keys = append(keys, m.key)
		}
	}
	return keys
}

// handlerJSON is the handler the client installs for e.
func handlerJSON(e entry, executable string, agent status.Agent) *object {
	h := &object{}
	h.set("type", rawJSON("command"))
	h.set("command", rawJSON(Command(executable, agent)))
	if e.timeout > 0 {
		h.set("timeout", rawJSON(e.timeout))
	}
	if e.async {
		h.set("async", rawJSON(true))
	}
	return h
}

// groupJSON is the compact matcher group the client installs for e.
func groupJSON(e entry, executable string, agent status.Agent) json.RawMessage {
	g := &object{}
	if e.matcher != "" {
		g.set("matcher", rawJSON(e.matcher))
	}
	g.set("hooks", &array{elems: []any{handlerJSON(e, executable, agent)}})
	var b compactBuffer
	if err := encode(&b.Buffer, g, "", 0); err != nil {
		panic(err)
	}
	return b.compact()
}

// eventArray returns the event's array, or nil when the event is absent.
func eventArray(hooks *object, event string) (*array, error) {
	value, ok := hooks.get(event)
	if !ok {
		return nil, nil
	}
	switch v := value.(type) {
	case *array:
		return v, nil
	case json.RawMessage:
		arr, ok := parseArray(v)
		if !ok {
			return nil, errEventNotArray
		}
		hooks.set(event, arr)
		return arr, nil
	}
	return nil, errEventNotArray
}

// groupOwnHandlers reports how many of a group's handlers are the client's
// and, when others remain, returns the group holding only those.
func groupOwnHandlers(raw json.RawMessage) (own int, rest *object) {
	if !isObject(raw) {
		return 0, nil
	}
	group, err := parseObject(raw)
	if err != nil {
		return 0, nil
	}
	value, ok := group.get("hooks")
	if !ok {
		return 0, nil
	}
	handlers, ok := parseArray(value.(json.RawMessage))
	if !ok {
		return 0, nil
	}
	var kept []any
	for _, h := range handlers.elems {
		if isOwnHandler(h.(json.RawMessage)) {
			own++
		} else {
			kept = append(kept, h)
		}
	}
	if own == 0 || len(kept) == 0 {
		return own, nil
	}
	group.set("hooks", &array{elems: kept})
	return own, group
}

func isOwnHandler(raw json.RawMessage) bool {
	var h struct {
		Command any `json:"command"`
	}
	if json.Unmarshal(raw, &h) != nil {
		return false
	}
	command, ok := h.Command.(string)
	return ok && IsOwnCommand(command)
}

// removeOwn drops the client's handlers from one event; a group left
// without handlers goes, and so does an event left without groups.
func removeOwn(hooks *object, event string) (bool, error) {
	arr, err := eventArray(hooks, event)
	if err != nil || arr == nil {
		return false, err
	}
	changed := false
	var kept []any
	for _, e := range arr.elems {
		raw, isRaw := e.(json.RawMessage)
		if !isRaw {
			kept = append(kept, e)
			continue
		}
		own, rest := groupOwnHandlers(raw)
		switch {
		case own == 0:
			kept = append(kept, e)
		case rest != nil:
			kept = append(kept, rest)
			changed = true
		default:
			changed = true
		}
	}
	if !changed {
		return false, nil
	}
	if len(kept) == 0 {
		hooks.remove(event)
	} else {
		arr.elems = kept
	}
	return true, nil
}

// install makes every event of the agent hold exactly one handler of the
// client, as specified, and removes the client's handlers from any other
// event (left by an earlier version).
func install(hooks *object, executable string, agent status.Agent) (bool, error) {
	changed := false
	wanted := entriesFor(agent)
	for _, event := range hooks.keys() {
		if slices.ContainsFunc(wanted, func(e entry) bool { return e.event == event }) {
			continue
		}
		removed, err := removeOwn(hooks, event)
		if err != nil {
			return false, err
		}
		changed = changed || removed
	}
	for _, e := range wanted {
		group := groupJSON(e, executable, agent)
		arr, err := eventArray(hooks, e.event)
		if err != nil {
			return false, err
		}
		if arr != nil && holdsExactly(arr, group) {
			continue
		}
		if _, err := removeOwn(hooks, e.event); err != nil {
			return false, err
		}
		if arr, err = eventArray(hooks, e.event); err != nil {
			return false, err
		}
		if arr == nil {
			arr = &array{}
			hooks.set(e.event, arr)
		}
		arr.elems = append(arr.elems, group)
		changed = true
	}
	return changed, nil
}

// holdsExactly reports whether the event's only group with a handler of
// the client is the wanted group itself.
func holdsExactly(arr *array, group json.RawMessage) bool {
	found := false
	for _, e := range arr.elems {
		raw, ok := e.(json.RawMessage)
		if !ok {
			return false
		}
		own, _ := groupOwnHandlers(raw)
		if own == 0 {
			continue
		}
		if found || !sameJSON(raw, group) {
			return false
		}
		found = true
	}
	return found
}
