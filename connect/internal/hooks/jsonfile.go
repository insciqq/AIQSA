package hooks

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// The settings files are edited as ordered trees: only the objects and
// arrays on the way to the hook entries are decoded; every other value stays
// the exact bytes the file held (re-indented when written), so key order,
// string escapes and number spellings survive.

type member struct {
	key   string
	value any // *object, *array or json.RawMessage
}

type object struct{ members []member }

type array struct{ elems []any }

var errNotObject = errors.New("not a JSON object")

// parseObject decodes raw as one JSON object whose values stay raw.
func parseObject(raw []byte) (*object, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if tok != json.Delim('{') {
		return nil, errNotObject
	}
	obj := &object{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, errNotObject
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		obj.members = append(obj.members, member{key: key, value: value})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after the JSON object")
	}
	return obj, nil
}

// parseArray decodes raw as one JSON array whose elements stay raw.
func parseArray(raw json.RawMessage) (*array, bool) {
	var elems []json.RawMessage
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '[' || json.Unmarshal(raw, &elems) != nil {
		return nil, false
	}
	arr := &array{elems: make([]any, len(elems))}
	for i, e := range elems {
		arr.elems[i] = e
	}
	return arr, true
}

func isObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// index returns the position of the last member named key (the one JSON
// readers use), or -1.
func (o *object) index(key string) int {
	for i := len(o.members) - 1; i >= 0; i-- {
		if o.members[i].key == key {
			return i
		}
	}
	return -1
}

func (o *object) get(key string) (any, bool) {
	if i := o.index(key); i >= 0 {
		return o.members[i].value, true
	}
	return nil, false
}

func (o *object) set(key string, value any) {
	if i := o.index(key); i >= 0 {
		o.members[i].value = value
		return
	}
	o.members = append(o.members, member{key: key, value: value})
}

func (o *object) remove(key string) {
	kept := o.members[:0]
	for _, m := range o.members {
		if m.key != key {
			kept = append(kept, m)
		}
	}
	o.members = kept
}

// encode writes v with indent per level; depth is the level v starts on.
func encode(b *bytes.Buffer, v any, indent string, depth int) error {
	prefix := strings.Repeat(indent, depth)
	switch value := v.(type) {
	case json.RawMessage:
		return json.Indent(b, bytes.TrimSpace(value), prefix, indent)
	case *object:
		if len(value.members) == 0 {
			b.WriteString("{}")
			return nil
		}
		b.WriteString("{\n")
		for i, m := range value.members {
			b.WriteString(prefix + indent)
			b.Write(encodeString(m.key))
			b.WriteString(": ")
			if err := encode(b, m.value, indent, depth+1); err != nil {
				return err
			}
			if i < len(value.members)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(prefix + "}")
		return nil
	case *array:
		if len(value.elems) == 0 {
			b.WriteString("[]")
			return nil
		}
		b.WriteString("[\n")
		for i, e := range value.elems {
			b.WriteString(prefix + indent)
			if err := encode(b, e, indent, depth+1); err != nil {
				return err
			}
			if i < len(value.elems)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(prefix + "]")
		return nil
	}
	return errors.New("unsupported JSON node")
}

func encodeString(s string) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

// rawJSON encodes v compactly without HTML escaping.
func rawJSON(v any) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return json.RawMessage(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}

// sameJSON compares two values ignoring insignificant whitespace.
func sameJSON(a, b json.RawMessage) bool {
	var ca, cb bytes.Buffer
	if json.Compact(&ca, a) != nil || json.Compact(&cb, b) != nil {
		return false
	}
	return bytes.Equal(ca.Bytes(), cb.Bytes())
}

// detectIndent returns the indentation of the file's first indented line,
// or two spaces.
func detectIndent(data []byte) string {
	for _, line := range bytes.Split(data, []byte("\n"))[1:] {
		trimmed := bytes.TrimLeft(line, " \t")
		if len(trimmed) == 0 || len(trimmed) == len(line) {
			continue
		}
		return string(line[:len(line)-len(trimmed)])
	}
	return "  "
}

type compactBuffer struct{ bytes.Buffer }

func (b *compactBuffer) compact() json.RawMessage {
	var out bytes.Buffer
	if err := json.Compact(&out, b.Bytes()); err != nil {
		panic(err)
	}
	return json.RawMessage(out.Bytes())
}
