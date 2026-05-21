# storage/ — Phase 2 placeholder

Reserved slot for a generic file-storage adapter to back the existing
Google Drive uploads (FILE-C1) with an S3-compatible alternative once
Drive's quota / latency becomes a problem.

| Provider | Env vars                                  | Status |
|----------|-------------------------------------------|--------|
| `s3`     | `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY`, `STORAGE_S3_SECRET_KEY` | placeholder |

Contract sketch:

```js
uploadFile(buffer, { key, contentType }) → { url, etag }
fetchFile(key) → Buffer
```

Implementation deferred to Phase 2.
