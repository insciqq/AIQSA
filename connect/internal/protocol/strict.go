package protocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Validator is implemented by every message type.
type Validator interface {
	Validate() error
}

// Decode strictly decodes one JSON object into v and validates it.
func Decode(data []byte, v Validator) error {
	if !isObject(data) {
		return errors.New("expected a JSON object")
	}
	if err := json.Unmarshal(data, v); err != nil {
		return err
	}
	return v.Validate()
}

func isObject(data []byte) bool {
	trimmed := bytes.TrimSpace(data)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// strictUnmarshal decodes a JSON object into the struct v points to with the
// semantics of a zod strict object: unknown keys, missing required keys and
// null values are errors. A field is optional when its json tag has
// omitempty, and may be null when it is also tagged connect:"nullable".
// v must point to a type without its own UnmarshalJSON, so callers pass an
// alias type; nested message types apply this through their own UnmarshalJSON.
func strictUnmarshal(data []byte, v any) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw == nil {
		return errors.New("expected a JSON object")
	}
	fields := strictFields(reflect.TypeOf(v).Elem())
	keys := make([]string, 0, len(raw))
	for key := range raw {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		field, known := fields[key]
		if !known {
			return fmt.Errorf("unknown field %q", key)
		}
		if !field.nullable && bytes.Equal(bytes.TrimSpace(raw[key]), []byte("null")) {
			return fmt.Errorf("%s: must not be null", key)
		}
	}
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if _, present := raw[name]; !present && !fields[name].optional {
			return fmt.Errorf("%s: required", name)
		}
	}
	return json.Unmarshal(data, v)
}

type strictField struct {
	optional bool
	nullable bool
}

func strictFields(t reflect.Type) map[string]strictField {
	fields := map[string]strictField{}
	for i := range t.NumField() {
		field := t.Field(i)
		tag := field.Tag.Get("json")
		if tag == "-" || !field.IsExported() {
			continue
		}
		name, options, _ := strings.Cut(tag, ",")
		if name == "" {
			name = field.Name
		}
		fields[name] = strictField{
			optional: slices.Contains(strings.Split(options, ","), "omitempty"),
			nullable: field.Tag.Get("connect") == "nullable",
		}
	}
	return fields
}

// Bytes is terminal output, standard padded base64 on the wire.
type Bytes []byte

func (b Bytes) MarshalJSON() ([]byte, error) {
	return json.Marshal(base64.StdEncoding.EncodeToString(b))
}

func (b *Bytes) UnmarshalJSON(data []byte) error {
	var encoded string
	if err := json.Unmarshal(data, &encoded); err != nil {
		return err
	}
	if len(encoded) > (MaxOutputChunkBytes+2)/3*4 {
		return errors.New("base64 data too long")
	}
	if !Base64Regexp.MatchString(encoded) {
		return errors.New("invalid base64 data")
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	*b = decoded
	return nil
}

// Field checks shared by the Validate methods.

func checkText(field, value string, max int) error {
	if value == "" {
		return fmt.Errorf("%s: required", field)
	}
	if utf8.RuneCountInString(value) > max {
		return fmt.Errorf("%s: longer than %d characters", field, max)
	}
	if ControlCharacterRegexp.MatchString(value) {
		return fmt.Errorf("%s: contains control characters", field)
	}
	return nil
}

func checkPath(field, value string, pattern *regexp.Regexp) error {
	if err := checkText(field, value, MaxCwdLength); err != nil {
		return err
	}
	if !pattern.MatchString(value) {
		return fmt.Errorf("%s: invalid path", field)
	}
	return nil
}

func checkBytesText(field, value string, min, max int) error {
	if len(value) < min || len(value) > max {
		return fmt.Errorf("%s: size must be %d..%d bytes", field, min, max)
	}
	return nil
}

func checkPattern(field, value string, pattern *regexp.Regexp) error {
	if !pattern.MatchString(value) {
		return fmt.Errorf("%s: invalid format", field)
	}
	return nil
}

func checkEnum[T ~string](field string, value T, allowed []T) error {
	if !slices.Contains(allowed, value) {
		return fmt.Errorf("%s: unsupported value %q", field, string(value))
	}
	return nil
}

func checkRange(field string, value, min, max int) error {
	if value < min || value > max {
		return fmt.Errorf("%s: must be %d..%d", field, min, max)
	}
	return nil
}

func checkTimestamp(field, value string) error {
	if !TimestampRegexp.MatchString(value) {
		return fmt.Errorf("%s: invalid timestamp", field)
	}
	if _, err := time.Parse(time.RFC3339, value); err != nil {
		return fmt.Errorf("%s: invalid timestamp", field)
	}
	return nil
}

func checkURL(field, value string) error {
	if len(value) > MaxURLLength || !URLPrefixRegexp.MatchString(value) {
		return fmt.Errorf("%s: invalid url", field)
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil {
		return fmt.Errorf("%s: invalid url", field)
	}
	return nil
}

func checkType(want, got string) error {
	if got != want {
		return fmt.Errorf("type: must be %q", want)
	}
	return nil
}

func checkList(field string, present bool, length, min, max int) error {
	if !present {
		return fmt.Errorf("%s: required", field)
	}
	if length < min || length > max {
		return fmt.Errorf("%s: must have %d..%d items", field, min, max)
	}
	return nil
}

func checkUnique(field string, keys []string) error {
	seen := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("%s: duplicate %q", field, key)
		}
		seen[key] = struct{}{}
	}
	return nil
}

func firstError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// FormatTimestamp formats t the way the contract expects: UTC with milliseconds.
func FormatTimestamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
