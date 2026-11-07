package hooks

import (
	"encoding/json"
	"errors"
	"slices"
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
