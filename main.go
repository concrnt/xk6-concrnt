package concrnt

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"go.k6.io/k6/js/modules"

	"github.com/cosmos/cosmos-sdk/codec/address"
	"github.com/cosmos/cosmos-sdk/crypto/keys/secp256k1"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
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
	Issuer         string `json:"iss,omitempty"` // 発行者
	Subject        string `json:"sub,omitempty"` // 用途
	Audience       string `json:"aud,omitempty"` // 想定利用者
	ExpirationTime string `json:"exp,omitempty"` // 失効時刻
	IssuedAt       string `json:"iat,omitempty"` // 発行時刻
	JWTID          string `json:"jti,omitempty"` // JWT ID
}

func (r *Concrnt) GenerateIdentity() Identity {
	privkey := secp256k1.GenPrivKey()
	pubkey := privkey.PubKey()

	fa := sdk.AccAddress(pubkey.Address())

	cdc := address.NewBech32Codec("con")
	addr, err := cdc.BytesToString(fa)
	if err != nil {
		panic(err)
	}

	keystr := hex.EncodeToString(privkey.Bytes())

	return Identity{
		Address: addr,
		Privkey: keystr,
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

func (r *Concrnt) GenerateAuthToken(identity Identity, aud string) string {

	header := Header{
		Type:      "JWT",
		Algorithm: "CONCRNT",
	}

	claims := Claims{
		Issuer:         identity.Address,
		Subject:        "concrnt",
		Audience:       aud,
		ExpirationTime: fmt.Sprintf("%d", time.Now().Add(time.Hour).Unix()),
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
