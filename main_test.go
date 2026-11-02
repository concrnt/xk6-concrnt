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
	return recoverAddressHRP(t, msg, sigHex, "con")
}

func recoverAddressHRP(t *testing.T, msg string, sigHex string, hrp string) string {
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
	return pubkeyToAddressHRP(crypto.CompressPubkey(ecdsaPub), hrp)
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

// pinned so a refactor of the derivation cannot silently change every seeded user
func TestIdentityFromSeedVector(t *testing.T) {
	c := &Concrnt{}
	id := c.IdentityFromSeed("concrnt-loadtest/user/0")
	if id.Address != "con1zt0hcy20snmlhze2gphuz9x4at84yfs3l5gwsr" ||
		id.Privkey != "c3c753f4d9df4d1f3f1d1734f676ba42b61c936b2b5fce0ef130e792b224c326" {
		t.Fatalf("identity vector changed: %+v", id)
	}
	sub := c.SubkeyFromSeed(id, "subkey")
	if sub.CKID != "cck1p8lqsdpwwsnvtfga6legvpdl0wmlu3cwr5pt0v" || sub.Parent != id.Address {
		t.Fatalf("subkey vector changed: %+v", sub)
	}
	if c.IdentityFromSeed("concrnt-loadtest/user/1").Address == id.Address {
		t.Fatal("different seeds produced the same identity")
	}
}

func TestGenerateSubkey(t *testing.T) {
	c := &Concrnt{}
	id := c.GenerateIdentity()
	sub := c.GenerateSubkey(id)
	if !strings.HasPrefix(sub.CKID, "cck1") || len(sub.CKID) != 42 || sub.Parent != id.Address {
		t.Fatalf("unexpected subkey %+v", sub)
	}
	if c.KeyURI(sub) != "cckv://"+id.Address+"/keys/"+sub.CKID {
		t.Fatalf("key uri %q", c.KeyURI(sub))
	}
}

func TestSignDocumentWithSubkey(t *testing.T) {
	c := &Concrnt{}
	id := c.GenerateIdentity()
	sub := c.GenerateSubkey(id)
	doc := `{"kind":"record","author":"` + id.Address + `"}`

	var sd SignedDocument
	if err := json.Unmarshal([]byte(c.SignDocumentWithSubkey(sub, doc)), &sd); err != nil {
		t.Fatal(err)
	}
	if sd.Proof.Type != ProofTypeSubkey || sd.Proof.Key == nil || *sd.Proof.Key != c.KeyURI(sub) {
		t.Fatalf("proof %+v", sd.Proof)
	}
	if got := recoverAddressHRP(t, sd.Document, sd.Proof.Signature, "cck"); got != sub.CKID {
		t.Fatalf("recovered %s, want %s", got, sub.CKID)
	}

	if strings.Contains(c.SignDocument(id, doc), `"key"`) {
		t.Fatal("direct proof must not carry a key")
	}
}

func TestGenerateAuthTokenWithSubkey(t *testing.T) {
	c := &Concrnt{}
	id := c.GenerateIdentity()
	sub := c.GenerateSubkey(id)
	parts := strings.Split(c.GenerateAuthTokenWithSubkey(sub, "example.com"), ".")
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
	if header.KeyID != c.KeyURI(sub) {
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
	if claims.Issuer != id.Address || claims.Audience != "example.com" {
		t.Fatalf("claims %+v", claims)
	}

	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	if got := recoverAddressHRP(t, parts[0]+"."+parts[1], hex.EncodeToString(sig), "cck"); got != sub.CKID {
		t.Fatalf("recovered %s, want %s", got, sub.CKID)
	}

	if strings.Contains(c.GenerateAuthToken(id, "example.com"), "kid") {
		t.Fatal("master-key token header changed")
	}
}

func TestNewCDIDX(t *testing.T) {
	c := &Concrnt{}
	a := c.NewCDIDX("cckv://con1example/concrnt.world/profiles/main/home-timeline")
	if a != c.NewCDIDX("cckv://con1example/concrnt.world/profiles/main/home-timeline") {
		t.Fatal("hash cdid is not deterministic")
	}
	if !cdid.IsHashCDID(a) {
		t.Fatalf("%q is not a hash cdid", a)
	}
}
