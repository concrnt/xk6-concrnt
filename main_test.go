package concrnt

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/concrnt/concrnt/cdid"
	"github.com/ethereum/go-ethereum/crypto"
	"golang.org/x/crypto/sha3"
)

func recoverAddress(t *testing.T, msg string, sigHex string) string {
	t.Helper()
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha3.NewLegacyKeccak256()
	hash.Write([]byte(msg))
	pub, err := crypto.Ecrecover(hash.Sum(nil), sig)
	if err != nil {
		t.Fatal(err)
	}
	ecdsaPub, err := crypto.UnmarshalPubkey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return pubkeyToAddress(crypto.CompressPubkey(ecdsaPub))
}

// vectors were produced by the previous cosmos-sdk based implementation
func TestAddressDerivationVectors(t *testing.T) {
	vectors := map[string]string{
		"1b1cd77e75c0c9146de1a3ae8c25399a7c613a38f1a7d7373b77dfd67006a443": "con1cv2p57uvjmfhd8ng2n6wwkx6uff36k32hlpjks",
		"c46d4cf7487f38652d7ff18ae4edaa455617e1629af465e06e9c953682edf7a9": "con1nth4rhuxe6k6whjt4khdzaf0fs8da8rgt3qv6s",
		"93a07c4e42b9d1be17a56d349bc3f2ba251091f8e69272951c8b6682904db414": "con1dcek5wh09djeh7u036h68dwggt8elp6dywq7fp",
	}
	for priv, want := range vectors {
		key, err := crypto.HexToECDSA(priv)
		if err != nil {
			t.Fatal(err)
		}
		if got := pubkeyToAddress(crypto.CompressPubkey(&key.PublicKey)); got != want {
			t.Fatalf("priv %s: got %s, want %s", priv, got, want)
		}
	}
}

func TestSignRecoversIdentity(t *testing.T) {
	c := &Concrnt{}
	id := c.GenerateIdentity()
	if !strings.HasPrefix(id.Address, "con1") || len(id.Address) != 42 {
		t.Fatalf("unexpected address %q", id.Address)
	}
	msg := `{"kind":"record","author":"` + id.Address + `"}`
	sig := c.Sign(id.Privkey, msg)
	if len(sig) != 130 {
		t.Fatalf("signature length %d", len(sig))
	}
	if got := recoverAddress(t, msg, sig); got != id.Address {
		t.Fatalf("recovered %s, want %s", got, id.Address)
	}
}

func TestSignDocument(t *testing.T) {
	c := &Concrnt{}
	id := c.GenerateIdentity()
	doc := `{"kind":"entity","author":"` + id.Address + `","value":{"domain":"example.com"}}`

	var sd SignedDocument
	if err := json.Unmarshal([]byte(c.SignDocument(id, doc)), &sd); err != nil {
		t.Fatal(err)
	}
	if sd.Document != doc {
		t.Fatalf("document altered: %q", sd.Document)
	}
	if sd.Proof.Type != ProofTypeEcrecover {
		t.Fatalf("proof type %q", sd.Proof.Type)
	}
	if got := recoverAddress(t, sd.Document, sd.Proof.Signature); got != id.Address {
		t.Fatalf("recovered %s, want %s", got, id.Address)
	}
}

func TestNewCDID(t *testing.T) {
	c := &Concrnt{}
	before := time.Now().Truncate(time.Millisecond)
	s := c.NewCDID("hello")
	if len(s) != 26 {
		t.Fatalf("cdid %q has length %d", s, len(s))
	}
	parsed, err := cdid.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.GetTime(); got.Before(before) || got.After(time.Now().Add(time.Second)) {
		t.Fatalf("cdid time %v out of range (now %v)", got, time.Now())
	}
}

func TestGenerateAuthToken(t *testing.T) {
	c := &Concrnt{}
	id := c.GenerateIdentity()
	token := c.GenerateAuthToken(id, "example.com")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d parts", len(parts))
	}

	var header Header
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		t.Fatal(err)
	}
	if header.Algorithm != "CONCRNT" || header.Type != "JWT" {
		t.Fatalf("header %+v", header)
	}

	var claims Claims
	raw, err = base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Subject != "concrnt" || claims.Audience != "example.com" || claims.Issuer != id.Address {
		t.Fatalf("claims %+v", claims)
	}

	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	if got := recoverAddress(t, parts[0]+"."+parts[1], hex.EncodeToString(sig)); got != id.Address {
		t.Fatalf("recovered %s, want %s", got, id.Address)
	}
}
