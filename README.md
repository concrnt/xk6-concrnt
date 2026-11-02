# xk6-concrnt

concrnt v2 向けの [k6](https://k6.io) 拡張と負荷試験シナリオです。

拡張 `k6/x/concrnt` は identity/subkey の生成(シードからの決定的導出を含む)、`/api/v2/commit` 用の署名(master key・subkey の両 proof)、CDID 生成、`kid` 付き JWT の発行を提供します。

```sh
GOWORK=off xk6 build --with github.com/concrnt/xk6-concrnt=.   # ./k6 ができる
./k6 run example.js                                             # 最小例
```

world-app の実トラフィックを再現する負荷試験は [`scenarios/`](scenarios/README.md) を参照してください(`make seed` → `make load`)。

## JS API

| 関数 | 説明 |
|---|---|
| `generateIdentity()` / `identityFromSeed(seed)` | `{address, privkey}`。seed 版は同じ seed で同じ identity |
| `generateSubkey(identity)` / `subkeyFromSeed(identity, seed)` | `{ckid, privkey, parent}` |
| `keyURI(subkey)` | `cckv://<ccid>/keys/<ckid>` |
| `sign(privkey, msg)` | keccak256 + secp256k1 recoverable 署名(hex) |
| `signDocument(identity, doc)` | `concrnt-ecrecover-direct` proof の SignedDocument JSON |
| `signDocumentWithSubkey(subkey, doc)` | `concrnt-ecrecover-subkey` proof(`key` 付き) |
| `newCDID(body)` / `newCDIDX(body)` | time-kind / hash-kind の CDID |
| `generateAuthToken(identity, aud)` / `generateAuthTokenWithSubkey(subkey, aud)` | 5 分有効の JWT(subkey 版は `kid` 付き) |
