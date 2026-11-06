package winapp

import (
	"errors"
	"testing"
)

func TestOriginFromFileName(t *testing.T) {
	accepted := map[string]string{
		"AIQSA Connect - ai.example.com.exe":                            "https://ai.example.com",
		"AIQSA Connect - ai.example.com_8443.exe":                       "https://ai.example.com:8443",
		"AIQSA Connect - AI.Example.COM.EXE":                            "https://ai.example.com",
		"aiqsa connect - ai.example.com.exe":                            "https://ai.example.com",
		"AIQSA Connect - ai.example.com (1).exe":                        "https://ai.example.com",
		"AIQSA Connect - ai.example.com (12).exe":                       "https://ai.example.com",
		"AIQSA Connect - ai.example.com(2).exe":                         "https://ai.example.com",
		"AIQSA Connect - ai.example.com_8443 (3).exe":                   "https://ai.example.com:8443",
		"AIQSA Connect - localhost_3000.exe":                            "https://localhost:3000",
		"AIQSA Connect - http_localhost_3000.exe":                       "http://localhost:3000",
		"AIQSA Connect - http_192.168.1.5_3000.exe":                     "http://192.168.1.5:3000",
		"AIQSA Connect - http_10.0.0.2.exe":                             "http://10.0.0.2",
		"AIQSA Connect - http_100.101.102.103_80 (1).exe":               "http://100.101.102.103:80",
		"AIQSA Connect - http_aiqsa.lan_3000.exe":                       "http://aiqsa.lan:3000",
		"AIQSA Connect - 203.0.113.7_443.exe":                           "https://203.0.113.7:443",
		`C:\Users\ivan\Downloads\AIQSA Connect - ai.v2.example.org.exe`: "https://ai.v2.example.org",
		"/mnt/c/Downloads/AIQSA Connect - ai.example.com.exe":           "https://ai.example.com",
		"AIQSA Connect - xn--80ak6aa92e.com.exe":                        "https://xn--80ak6aa92e.com",
	}
	for name, want := range accepted {
		got, err := OriginFromFileName(name)
		if err != nil || got != want {
			t.Errorf("%q: got %q %v, want %q", name, got, err, want)
		}
	}
	rejected := []string{
		"aiqsa-connect.exe",
		"aiqsa-connect-windows-amd64.exe",
		"AIQSA Connect.exe",
		"AIQSA Connect - .exe",
		"AIQSA Connect - ai.example.com",
		"AIQSA Connect - ai.example.com.exe.txt",
		"AIQSA Connect - ai.example.com_.exe",
		"AIQSA Connect - ai.example.com_0.exe",
		"AIQSA Connect - ai.example.com_99999.exe",
		"AIQSA Connect - ai.example.com_84a3.exe",
		"AIQSA Connect - ai.example.com_8443_1.exe",
		"AIQSA Connect - ai example.com.exe",
		"AIQSA Connect - user@ai.example.com.exe",
		"AIQSA Connect - -ai.example.com.exe",
		"AIQSA Connect - ai..example.com.exe",
		"AIQSA Connect - [2001;db8;;1].exe",
		"AIQSA Connect - https_ai.example.com.exe",
		"AIQSA Connect - ftp_ai.example.com.exe",
		// http only to local-network addresses.
		"AIQSA Connect - http_8.8.8.8_80.exe",
		"AIQSA Connect - http_203.0.113.7.exe",
		"AIQSA Connect - ai.example.com (1) (2).exe",
		"Copy of AIQSA Connect - ai.example.com.exe",
	}
	for _, name := range rejected {
		if got, err := OriginFromFileName(name); !errors.Is(err, ErrUnrecognizedFileName) {
			t.Errorf("%q: got %q %v, want a refusal", name, got, err)
		}
	}
}
