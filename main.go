package concrnt

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"go.k6.io/k6/js/modules"

	"github.com/btcsuite/btcd/btcutil/bech32"
	"github.com/concrnt/concrnt/cdid"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
	"golang.org/x/crypto/ripemd160"
	"golang.org/x/crypto/sha3"
)

func init() {
	modules.Register("k6/x/concrnt", new(Concrnt))
}

type Concrnt struct {
}

type Identity struct {
	Address string `js:"address"`
	Privkey string `js:"privkey"`
}

// Subkey is a CIP-13 subkey: the CKID is derived like a CCID but with hrp "cck".
type Subkey struct {
	CKID    string `js:"ckid"`
	Privkey string `js:"privkey"`
	Parent  string `js:"parent"`
}

type Header struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
	KeyID     string `json:"kid,omitempty"`
}

type Claims struct {
	Issuer         string `json:"iss,omitempty"`
	Subject        string `json:"sub,omitempty"`
	Audience       string `json:"aud,omitempty"`
	ExpirationTime string `json:"exp,omitempty"`
	IssuedAt       string `json:"iat,omitempty"`
	JWTID          string `json:"jti,omitempty"`
}

const (
	ProofTypeEcrecover = "concrnt-ecrecover-direct"
	ProofTypeSubkey    = "concrnt-ecrecover-subkey"
)

type Proof struct {
	Type      string  `json:"type"`
	Signature string  `json:"signature"`
	Key       *string `json:"key,omitempty"`
}

type SignedDocument struct {
	Document string `json:"document"`
	Proof    Proof  `json:"proof"`
}

// pubkeyToAddress derives the CCID the same way cosmos-sdk does:
// bech32("con", ripemd160(sha256(compressed pubkey))).
func pubkeyToAddress(compressed []byte) string {
	return pubkeyToAddressHRP(compressed, "con")
}

func pubkeyToAddressHRP(compressed []byte, hrp string) string {
	sha := sha256.Sum256(compressed)
	rip := ripemd160.New()
	rip.Write(sha[:])
	words, err := bech32.ConvertBits(rip.Sum(nil), 8, 5, true)
	if err != nil {
		panic(err)
	}
	addr, err := bech32.Encode(hrp, words)
	if err != nil {
		panic(err)
	}
	return addr
}

// privkeyFromSeed hashes the seed into a secp256k1 scalar; the rare
// out-of-range hash is re-hashed with a counter suffix.
func privkeyFromSeed(seed string) *ecdsa.PrivateKey {
	for i := 0; ; i++ {
		s := seed
		if i > 0 {
			s = fmt.Sprintf("%s:%d", seed, i)
		}
		hash := sha3.NewLegacyKeccak256()
		hash.Write([]byte(s))
		key, err := crypto.ToECDSA(hash.Sum(nil))
		if err == nil {
			return key
		}
	}
}

func (r *Concrnt) GenerateIdentity() Identity {
	key, err := crypto.GenerateKey()
	if err != nil {
		panic(err)
	}

	return Identity{
		Address: pubkeyToAddress(crypto.CompressPubkey(&key.PublicKey)),
		Privkey: hex.EncodeToString(crypto.FromECDSA(key)),
	}
}

// IdentityFromSeed returns the same identity for the same seed, so seed and
// load scripts agree on the user set without sharing a file.
func (r *Concrnt) IdentityFromSeed(seed string) Identity {
	key := privkeyFromSeed("xk6-concrnt:" + seed)
	return Identity{
		Address: pubkeyToAddress(crypto.CompressPubkey(&key.PublicKey)),
		Privkey: hex.EncodeToString(crypto.FromECDSA(key)),
	}
}

func (r *Concrnt) GenerateSubkey(parent Identity) Subkey {
	key, err := crypto.GenerateKey()
	if err != nil {
		panic(err)
	}
	return Subkey{
		CKID:    pubkeyToAddressHRP(crypto.CompressPubkey(&key.PublicKey), "cck"),
		Privkey: hex.EncodeToString(crypto.FromECDSA(key)),
		Parent:  parent.Address,
	}
}

func (r *Concrnt) SubkeyFromSeed(parent Identity, seed string) Subkey {
	key := privkeyFromSeed("xk6-concrnt-subkey:" + parent.Privkey + ":" + seed)
	return Subkey{
		CKID:    pubkeyToAddressHRP(crypto.CompressPubkey(&key.PublicKey), "cck"),
		Privkey: hex.EncodeToString(crypto.FromECDSA(key)),
		Parent:  parent.Address,
	}
}

func (r *Concrnt) KeyURI(sub Subkey) string {
	return "cckv://" + sub.Parent + "/keys/" + sub.CKID
}

func (r *Concrnt) Sign(privkey string, msg string) string {

	hash := sha3.NewLegacyKeccak256()
	hash.Write([]byte(msg))
	hashed := hash.Sum(nil)

	key, err := crypto.HexToECDSA(privkey)
	if err != nil {
		panic(err)
	}

	signature, err := crypto.Sign(hashed, key)
	if err != nil {
		panic(err)
	}

	sigstr := hex.EncodeToString(signature)

	return sigstr
}

// SignDocument wraps a serialized document into the SignedDocument body
// accepted by /api/v2/commit and /api/v2/register (master-key proof).
func (r *Concrnt) SignDocument(identity Identity, document string) string {
	sd := SignedDocument{
		Document: document,
		Proof: Proof{
			Type:      ProofTypeEcrecover,
			Signature: r.Sign(identity.Privkey, document),
		},
	}

	body, err := json.Marshal(sd)
	if err != nil {
		panic(err)
	}

	return string(body)
}

// SignDocumentWithSubkey is the proof world-app uses for everyday commits;
// the server resolves proof.key (the enact document) to verify it.
func (r *Concrnt) SignDocumentWithSubkey(sub Subkey, document string) string {
	key := r.KeyURI(sub)
	sd := SignedDocument{
		Document: document,
		Proof: Proof{
			Type:      ProofTypeSubkey,
			Signature: r.Sign(sub.Privkey, document),
			Key:       &key,
		},
	}

	body, err := json.Marshal(sd)
	if err != nil {
		panic(err)
	}

	return string(body)
}

// NewCDID returns the time-kind CDID world-app uses as a post key:
// keccak256(body)[:10] combined with the current time.
func (r *Concrnt) NewCDID(body string) string {
	hash := sha3.NewLegacyKeccak256()
	hash.Write([]byte(body))
	hashed := hash.Sum(nil)

	var data [10]byte
	copy(data[:], hashed[:10])

	return cdid.New(data, time.Now()).String()
}

// NewCDIDX is the hash-kind CDID world-app uses for list items (newFromStringX),
// so the same href always maps to the same key.
func (r *Concrnt) NewCDIDX(body string) string {
	return cdid.MakeHash([]byte(body)).String()
}

func (r *Concrnt) GenerateAuthToken(identity Identity, aud string) string {
	return buildToken(Header{Type: "JWT", Algorithm: "CONCRNT"}, identity.Address, aud, identity.Privkey)
}

// GenerateAuthTokenWithSubkey mirrors world-app: kid names the subkey, iss is
// the owner, and the signature is made with the subkey.
func (r *Concrnt) GenerateAuthTokenWithSubkey(sub Subkey, aud string) string {
	return buildToken(Header{Type: "JWT", Algorithm: "CONCRNT", KeyID: r.KeyURI(sub)}, sub.Parent, aud, sub.Privkey)
}

func buildToken(header Header, issuer string, aud string, privkey string) string {
	claims := Claims{
		Issuer:         issuer,
		Subject:        "concrnt",
		Audience:       aud,
		ExpirationTime: fmt.Sprintf("%d", time.Now().Add(5*time.Minute).Unix()),
		IssuedAt:       fmt.Sprintf("%d", time.Now().Unix()),
		JWTID:          uuid.New().String(),
	}

	headerStr, err := json.Marshal(header)
	if err != nil {
		panic(err)
	}

	payloadStr, err := json.Marshal(claims)
	if err != nil {
		panic(err)
	}

	headerB64 := base64.RawURLEncoding.EncodeToString([]byte(headerStr))
	payloadB64 := base64.RawURLEncoding.EncodeToString([]byte(payloadStr))
	target := headerB64 + "." + payloadB64

	signatureHex := (&Concrnt{}).Sign(privkey, target)
	signatureBytes, err := hex.DecodeString(signatureHex)
	if err != nil {
		panic(err)
	}
	signatureB64 := base64.RawURLEncoding.EncodeToString(signatureBytes)

	return target + "." + signatureB64
}
