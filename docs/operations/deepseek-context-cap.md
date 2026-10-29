# DeepSeek context-window cap — per-lane giải pháp và hướng revert

Ghi ngày 2026-10-29, khi provider đang lỗi và toàn bộ công việc round-13 đang pause.

## Bối cảnh

- Provider serving DeepSeek (`cx` endpoint, model id `wdb/deepseek-ai/DeepSeek-V4.1-Flash`) đang lỗi ở context lớn. Owner muốn subagent (vibe workers) chạy DeepSeek với context window giới hạn 200k để tránh lỗi, trong khi main session và các lane khác giữ nguyên.
- Đã xác minh qua docs OMP (round này):
  - Agent frontmatter KHÔNG có field `contextWindow` (chỉ: name/description/systemPrompt/tools/spawns/model/thinkingLevel/output/blocking/structured/autoloadSkills/readSummarize/prewalk/advisor).
  - `task.agentCompactionThresholdOverrides` áp cho task/eval agents, KHÔNG ăn vibe workers (docs: "The main session and Vibe workers are unaffected").
  - Registry định danh model theo `provider + id`; wire name = model id. Gateway chỉ đọc id, không đọc provider name. Vì vậy 1 provider alias trùng endpoint + trùng id nhưng metadata khác → OMP coi là model khác, request tới endpoint y hệt. (Merge rule: "a matching `provider + id` replaces transport metadata and patches defined model fields; otherwise append a model, filling omitted metadata from a bundled reference or local defaults".)
  - Custom `models` entry schema check: "require positive `contextWindow` and `maxTokens` when provided" — NÊN set cả hai để tránh case schema từ chối làm drop cả file models.yml (điều đó giết luôn lane gpt-6-luna).

## Giải pháp

Hai file, hai bước. Backup cả hai trước.

### Bước 1 — `~/.omp/agent/models.yml`: thêm provider alias `cx-cap`

Chèn block sau NGAY SAU block provider `cx` (trước `ag:`), indent 2 spaces cho key provider:

```yaml
  cx-cap:
    baseUrl: http://100.67.250.108:20128/v1
    api: openai-completions
    apiKey: <CÙNG GIÁ TRỊ apiKey của provider cx — không ghi ở đây, copy từ cx block khi áp dụng>
    authHeader: true

    models:
      - id: wdb/deepseek-ai/DeepSeek-V4.1-Flash
        name: DeepSeek V4.1 Flash (200k)
        contextWindow: 200000
        maxTokens: 16384
```

Quy tắc bắt buộc:

- `id` phải NGUYÊN VẸN có prefix `wdb/` — đây là wire name gateway nhận. Đừng tách thành `deepseek-ai/DeepSeek-V4.1-Flash`.
- `baseUrl`, `api`, `apiKey`, `authHeader` copy y hệt từ provider `cx`.
- Key mapping trong YAML có thể quote: `"wdb/deepseek-ai/DeepSeek-V4.1-Flash":` — nhưng dạng YAML entry trong list `models:` (`- id: ...`) không cần quote.

### Bước 2 — `~/.omp/agent/config.yml`: route chỉ vibe workers sang alias

**CHỈ SỬA 2 DÒNG** trong block `agentModelOverrides` hiện có. KHÔNG paste lại nguyên block — block hiện có 12 key override (sonic, task, reviewer, scout, gemini, gemini-scout, gemini-audit, glm-audit, qwen-audit, v41audit, v41review, security-reviewer); paste block mới sẽ xóa 10 key còn lại. `enableEffort` và `maxEffort` cũng đã tồn tại — không đụng.

```yaml
task:
  enableEffort: true
  agentModelOverrides:
    sonic: "cx-cap/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high"   # vibe fast — SỬA DÒNG NÀY
    task: "cx-cap/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high"    # vibe good — SỬA DÒNG NÀY
    reviewer: cx/gpt-6-luna:high          # ← giữ nguyên mọi key còn lại y như cũ
    # ... 10 key nữa giữ nguyên ...
  maxEffort: high
```

Block trên là minh họa cấu trúc, không phải nội dung thay thế: giá trị thật của 10 key còn lại lấy từ file hiện hành (đang là `cx/gpt-6-luna:high` sau đợt đổi HIGH ngày 2026-10-29).

### Tác động

| Lane | Window sau khi áp |
|---|---|
| Main session | Không đổi (selector gốc) |
| `modelRoles.default` / `vision` / `deepseek_v41_hi` | Không đổi |
| `retry.fallbackChains` rơi vào DeepSeek | Không đổi — vẫn window gốc. Nếu muốn cap cả fallback, đổi entry chain sang alias `cx-cap/...` (tùy chọn, không bắt buộc) |
| Vibe workers fast (`sonic`) + good (`task`) | 200k, compaction trigger ~170k (85% mặc định) → không chạm vùng lỗi provider |

Prompt-cache phía gateway vẫn chung (cùng wire name) — không hại. Usage stats tách dòng cho 2 identity cùng model — chấp nhận được.

## Verify sau khi áp (bắt buộc, theo thứ tự)

1. YAML cục bộ (không cần provider sống):
   ```bash
   python3 - <<'EOF'
   import yaml
   d = yaml.safe_load(open('/home/heheboiz/.omp/agent/models.yml'))
   cap = d['providers'].get('cx-cap')
   assert cap, 'cx-cap missing'
   m = cap['models'][0]
   assert m['id'] == 'wdb/deepseek-ai/DeepSeek-V4.1-Flash'
   assert m['contextWindow'] == 200000 and m['maxTokens'] > 0
   assert d['providers']['cx']['models']  # lane gốc còn nguyên
   print('ok')
   EOF
   ```
2. Catalog (khi provider sống): `omp models 2>&1 | grep -i deepseek` — thấy alias với window 200k VÀ `cx/cx/gpt-6-luna` vẫn còn (guard chống case schema drop cả file).
3. Probe một worker: spawn 1 vibe worker `fast` ngắn, đọc `"model"` trong kết quả turn — phải là `cx-cap/wdb/deepseek-ai/DeepSeek-V4.1-Flash`. Trước khi spawn hàng loạt.

## Revert (khi context window provider khôi phục)

1. `cp -p ~/.omp/agent/models.yml.bak-20261029-cix ~/.omp/agent/models.yml`
2. `cp -p ~/.omp/agent/config.yml.bak-20261029-cix ~/.omp/agent/config.yml`
3. Verify: `python3 -c "import yaml; d=yaml.safe_load(open('/home/heheboiz/.omp/agent/models.yml')); assert 'cx-cap' not in d['providers']; print('reverted')"` và grep `config.yml` không còn `cx-cap`.

Backups (đã tạo 2026-10-29, trước khi có chỉnh sửa nào):
- `~/.omp/agent/models.yml.bak-20261029-cix`
- `~/.omp/agent/config.yml.bak-20261029-cix`

Lưu ý: các backup cũ khác (`config.yml.bak-20261029`, `config.yml.bak-20261027T012609`) là của các lần config khác — không dùng chúng cho revert này.

## Trạng thái hiện tại (2026-10-29, round r14)

- ÁP DỤNG: `models.yml` có provider `cx-cap` (contextWindow 200000, maxTokens 16384) — alias trùng endpoint/id với `cx`, chỉ khác metadata. `config.yml`: `modelRoles.task` + `modelRoles.smol` và CẢ 12 `task.agentModelOverrides` (sonic, task, reviewer, scout, gemini, gemini-scout, gemini-audit, glm-audit, qwen-audit, v41audit, v41review, security-reviewer) → `cx-cap/wdb/deepseek-ai/DeepSeek-V4.1-Flash:high`; `retry.fallbackChains` mọi entry GPT → `cx-cap/...`. `vision` vẫn `cx/gpt-6-luna:high` (không dùng round này), `advisor` GLM giữ nguyên, `default` GLM-Flash giữ nguyên.
- Compaction: runtime log `omp.2026-10-29.*.log` "Auto-compaction threshold decision" cho cx-cap ra `contextWindow:200000, thresholdTokens:170000` (85% mặc định) — KHÔNG cần knob config; `compaction.thresholdPercent=-1`, `thresholdTokens=-1` (defaults), `compaction.modelThresholds={}`.
- Backup round này: `~/.omp/agent/{config,models}.yml.bak-20261029-r14`. Revert = `cp -p` 2 file đó về.
- Smoke: worker `sonic` chạy qua `cx-cap` (journal + log `provider:"cx-cap"`, `model:"wdb/deepseek-ai/DeepSeek-V4.1-Flash"`), turn OK, không đụng GPT/Gemini.

## Trạng thái cũ (2026-10-29, round-13 lúc pause — đã lỗi thời)

- File này CHƯA commit — nằm untracked trong repo, sẽ được commit cùng batch round-13 khi resume (ghi nhớ khi `git add`).
- Chưa áp dụng. `models.yml` đã từng bị sửa thử rồi REVERT về nguyên trạng (verify pass: chỉ còn `cx`, `ag`, `or`). `config.yml` chưa từng bị đụng.
- Không spawn worker, không chạy test/build trong lúc pause.
- Khi owner mở lại: áp Bước 1 + 2 theo đúng snippet, chạy Verify, rồi mới resume round-13 (diff audit worker → REPORT.md đối chiếu → Fix → Verify → Handoff).
