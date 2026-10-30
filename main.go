package concrnt

import (
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
	Address string
	Privkey string
}

type Header struct {
	Algorithm string `json:"alg"`
	Type      string `json:"typ"`
}

type Claims struct {
	Issuer         string `json:"iss,omitempty"`
	Subject        string `json:"sub,omitempty"`
	Audience       string `json:"aud,omitempty"`
	ExpirationTime string `json:"exp,omitempty"`
	IssuedAt       string `json:"iat,omitempty"`
	JWTID          string `json:"jti,omitempty"`
}

const ProofTypeEcrecover = "concrnt-ecrecover-direct"

type Proof struct {
	Type      string `json:"type"`
	Signature string `json:"signature"`
}

type SignedDocument struct {
	Document string `json:"document"`
	Proof    Proof  `json:"proof"`
}

// pubkeyToAddress derives the CCID the same way cosmos-sdk does:
// bech32("con", ripemd160(sha256(compressed pubkey))).
func pubkeyToAddress(compressed []byte) string {
	sha := sha256.Sum256(compressed)
	rip := ripemd160.New()
	rip.Write(sha[:])
	words, err := bech32.ConvertBits(rip.Sum(nil), 8, 5, true)
	if err != nil {
		panic(err)
	}
	addr, err := bech32.Encode("con", words)
	if err != nil {
		panic(err)
	}
	return addr
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

func (r *Concrnt) GenerateAuthToken(identity Identity, aud string) string {

	header := Header{
		Type:      "JWT",
		Algorithm: "CONCRNT",
	}

	claims := Claims{
		Issuer:         identity.Address,
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

	signatureHex := r.Sign(identity.Privkey, target)
	signatureBytes, err := hex.DecodeString(signatureHex)
	if err != nil {
		panic(err)
	}
	signatureB64 := base64.RawURLEncoding.EncodeToString(signatureBytes)

	return target + "." + signatureB64
}
