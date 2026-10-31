# Round 27: audit toàn repo, sửa lỗi và xác minh

Baseline được audit: `26874b01f30587cf3b389e7877fafa2b46a14eb7` (`main`, cây sạch lúc bắt đầu).
Sáu agent audit độc lập chạy trên phạm vi rời nhau, cộng thêm một lượt đối kháng (adversarial) tấn
công các tuyên bố mạnh nhất, một lượt phân loại finding các vòng trước (`F00–F13`, `R01–R03`), và một
lượt audit hậu sửa (post-fix) đọc lại cây làm việc. Toàn bộ số liệu trong tài liệu này lấy từ
`/home/heheboiz/.cache/caw-audit-r27/audit/*.md`, `/home/heheboiz/.cache/caw-audit-r27/findings/*.md`
và `/home/heheboiz/data/caw-audit-r27/findings/F-series.md`. Không có số nào được làm tròn có lợi.

> **Bản này đã được cập nhật theo cây đã sửa.** Bản đầu viết trước vòng 2 và vòng 3 và trước
> `ca9a7be`; nó còn ghi `API-01`/`STATIC-01` là không có fix và trích cổng lần chạy đầu
> (`127 file / 878 test`, `76/76`). Bản cập nhật này (commit `58a1c82`, `HEAD == origin/main`) đối
> chiếu với cây cuối `ca9a7be` — commit code cuối cùng, `HEAD` trước bản sửa tài liệu này — nơi cả
> hai fix đã có; mọi số dưới đây giờ lấy từ `audit/final-gates.md`, `audit/playwright-results.md`,
> `audit/fixes.md` và CI run `41183496042`. Bản thân `58a1c82` chỉ sửa tài liệu, không chạm code hay
> test.

> **Tuyên bố phạm vi, đọc trước khi trích dẫn.** Không agent nào khẳng định repo không còn lỗi. Hai
> agent báo cáo không có P0/P1 trong phạm vi của họ — đó là phát biểu về những gì họ đọc, không phải
> bảo đảm. File bị đánh `not-inspected` trong `source-inventory.md` không mang phán quyết nào cả.

## 1. Phạm vi

### 1.1 Sáu agent audit độc lập

| Agent | Phạm vi | Finding trong lượt này |
|---|---|---|
| A-backend | Backend, auth, persistence, filesystem, path-policy, config, startup/shutdown. 22 file đã mở (10 file nguồn/schema được giao, 8 test server, 3 tài liệu kiến trúc/ADR + `packages/relay/src/relay.ts`) | `API-01` (P3), `STATIC-01` (P4) |
| B-runtime | Runtime supervisor, OMP adapter, quyền sở hữu tmux, session lease, session/model catalog. 23 file | `RUNTIME-01` (P2) |
| C-web | Frontend web: `App.tsx`, `api.ts`, `mutation-order.ts`, `sanitize.ts`, `transcript.ts`, `styles.css`, 8 component. Kèm bảng kiểm kê async/race 12 dòng | `WEB-01` (P2), `WEB-02` (P2) |
| D-guest | Guest protocol: socket, client, codec, link, app shell, connect screen, agent drawer, tool-render `parts/util` | `D-GUEST-01` (P2), `D-GUEST-03` (P2), `D-GUEST-02` (P3) |
| E-tests-tooling | Tests, tooling, CI, cleanup, E2E: 5/5 `scripts/*.mjs`, `.github/workflows/ci.yml`, `playwright.config.ts`, `vitest.config.ts`, 2 tsconfig, `package.json`, `pnpm-workspace.yaml`, tài liệu `docs/operations/*` | `TOOL-01` (P2), `E2E-01` (P2), `E2E-02` (P3), `TOOL-02` (P3 → bị bác) |
| F-render | Guest rendering: 29 renderer `tool-render/tools/*.tsx`, `parts.tsx`, `util.ts`, `ToolView.tsx`, transcript components, `lib/{jsonl,format,transcript-poll}` | `RENDER-01` (P1→P2), `RENDER-02` (P1→P2), `RENDER-03` (P2) |

Cộng thêm:
- **Lượt đối kháng** (`findings/adversarial.md`) — chạy thật 6 tuyên bố: RUNTIME-01, RENDER-01,
  RENDER-02, D-GUEST-01, D-GUEST-03, TOOL-02. Kết quả: 1 UPHELD, 3 PARTIALLY_UPHELD, 1 WEAKENED,
  1 REFUTED.
- **Lượt F-series** (`data/caw-audit-r27/findings/F-series.md`) — phân loại `F00–F13`, `R01–R03`
  đọc bằng `git show HEAD:` để sửa song song không làm lệch kết quả.
- **Lượt hậu sửa** (`audit/independent-review.md`) — đọc lại cây làm việc, tìm ra 6 defect mới do
  chính đợt sửa gây ra (D1–D6) và **rút lại 2 finding** của chính nó sau khi đọc lại nguồn.

Đếm theo file findings của sáu agent: A=2, B=1, C=2, D=3, E=4, F=3 = **15** (E=4 đã gồm cả
`TOOL-02`); cộng `ACTIVITY-01` (được ghi ở lượt hợp nhất, **không** có trong bất kỳ file findings
khu vực nào) và `COMPOSER-01` (vòng 3 phát hiện — xem §7) = **17 dòng trong bảng ledger**: 16
`CONFIRMED` + 1 `INVALID_FINDING` (`TOOL-02`). Mission brief nói "18 dòng incl. `COMPOSER-01`"; bảng
trong `audit/findings.md` có đúng **17** finding row — `grep -c "^| [A-Z]"` trả `18` vì nó tính cả
dòng header `| ID | Sev | … |`. Cách đếm này khớp `audit/final-report.md` §C.2.

### 1.2 Số file first-party và tỷ lệ đọc thật

Lấy từ `coverage-matrix.md` và `source-inventory.md` (`git ls-files` tại HEAD = 447 file; mọi số
đếm dòng lấy từ git object, không từ filesystem đang bị sửa song song).

| Chỉ số | Giá trị |
|---|---:|
| File first-party (`apps/` + `packages/`, trừ vendored và `public/`) | **140** |
| LOC first-party | 23.727 |
| File **fully-read** bởi một agent có tên | **70** |
| File **partially-read** | 45 |
| File **static-scan-only** | 0 |
| File **not-inspected** | 25 |

Tỷ lệ: fully-read = **50,0%** số file first-party; fully-read + partially-read = **82,1%**;
LOC first-party đọc trọn ≈ **60,6%**.

**Nói thẳng:** audit này chỉ đọc trọn **~50%** số file first-party. 45 file (39,4% LOC) chỉ được
xem qua khoảng dòng/excerpt hoặc output của reader có dải bị gộp — kết luận về chúng giới hạn trong
phần đã hiển thị. 25 file chưa từng được mở. Không agent nào đọc 24.595 dòng của `tests/` theo từng
dòng; **hầu hết file test được grep chứ không được đọc** (E-tests-tooling nói rõ điều này). Theo
package: `apps/web` có **0** file fully-read (17 partially-read), `packages/collab-protocol` cũng
**0** fully-read (6 partially-read) — đây đúng là hai khu vực chứa D-GUEST-01/02/03 và WEB-01/02.

### 1.3 Xác minh đã thực sự chạy trong lượt audit (trước khi sửa)

| # | Lệnh | Kết quả | Nguồn |
|---|---|---|---|
| 1 | `TMPDIR=/var/tmp/caw-tmp node node_modules/vitest/vitest.mjs run tests/runtime/state.test.ts tests/runtime/supervisor.test.ts tests/adapter/tmux.test.ts tests/adapter/session-lease.test.ts tests/adapter/session-catalog.test.ts tests/adapter/collab-registry.test.ts tests/adapter/model-catalog.test.ts --maxWorkers=4` | 7 file PASS, 170 test PASS | B-runtime |
| 2 | `env PATH=/nonexistent /usr/bin/node scripts/capture-screens.mjs; printf 'exit=%s\n' "$?"` | `exit=0` (tái hiện `TOOL-01`) | E-tests-tooling |

Mọi thứ khác trong lượt audit là **source-derived hoặc search-derived và KHÔNG CHẠY**. Cụ thể: không
chạy full test suite, không chạy `pnpm test:e2e`, không instrumentation coverage, không launch
OMP/agent thật, không fault-injection HTTP, không chạy trình duyệt/assistive technology, không chạy
test relay/protocol/web, không mở ảnh nào. Kết quả xanh ở dòng 1 **không** bao phủ ca
disconnected-relay + `busy:true` của RUNTIME-01 (B-runtime tự nói vậy) và không bao phủ finding
render của guest.

## 2. Bảng findings

17 dòng theo ledger (cột "Trạng thái" là trạng thái **tại cây cuối `ca9a7be`** — commit code cuối
cùng — không phải trạng thái tại HEAD audit `26874b0`).

| ID | Mức | File:line (HEAD) | Mô tả ngắn | Trạng thái |
|---|---|---|---|---|
| RUNTIME-01 | P2 | `packages/runtime/src/state.ts:31`, `:141-146` | `relayConnected === false` rút ngắn thành `idle` trước khi xét `busy`; lượt đang chạy bị ghi là "không có lượt nào" | **Đã sửa** — bỏ hai nhánh `idle` sớm; thêm ghi chú relay vào detail (`state.ts:34`, `:173-180`); `supervisor.ts:770-786`, `:1002-1023` | 
| WEB-01 | P2 | `apps/web/src/App.tsx:58-60`, `:73-74` | Lỗi tạm thời của `getCapabilities`/`getMe` (500/network, bất kỳ thứ gì ≠ 403) bị coi là "chưa đăng nhập" | **Đã sửa** — tách 401/403 khỏi lỗi tạm; `startupFailure` + nút Retry (`App.tsx:64`, `:91`, `:97-103`) |
| WEB-02 | P2 | `ProjectsView.tsx:520-525`; `FolderBrowser.tsx:263-269`, `:276-285`; `ProjectDetailView.tsx:143-145` | Card/row điều hướng là `<div onClick>`: không có tab stop, Enter/Space vô tác dụng | **Đã sửa** — `role="button"` + `tabIndex` + key handler (`ProjectsView.tsx:593-601`, `ProjectDetailView.tsx:147+`); folder row thành `<button>` thật (`FolderBrowser.tsx:270-286`) |
| RENDER-01 | P1→P2 | `packages/guest/src/tool-render/tools/web-search.tsx:66-74` | `str(source.url)` gắn thẳng vào `<a href>`, không qua `safeHref` | **Đã sửa** — `safeHref` tại `:72`, `rel="noopener noreferrer"` tại `:76`. Lượt đối kháng **WEAKENED**: CSP `script-src 'self'` chặn `javascript:` trên Chromium, anchor `target="_blank"` không bao giờ chạy URL trong trang mở. Giá trị thật là nhất quán policy |
| RENDER-02 | P1→P2 | `parts.tsx:241-247`, `:272-275` | Mọi `mimeType` (chuỗi) đi vào `new Blob` + `URL.createObjectURL` + `window.open`, và thumbnail `data:` | **Đã sửa** — `isRasterImageMime` (png/jpeg/gif/webp) `util.ts:171-182`, lọc ở `:195`, note ở `parts.tsx:266`/`:292`. Lượt đối kháng **PARTIALLY_UPHELD**: payload trong claim không chạy (`execRuns=[false×6]`) — đóng primitive tiềm ẩn, không đóng lỗ khai thác đã chứng minh |
| RENDER-03 | P2 | `util.ts:156-162`, `:172-176`; `Transcript.tsx:127-165` | `block.type` bị deref không kiểm tra object → entry `null`/primitive ném lỗi khi render, không có error boundary nào trong `packages/guest/src` | **Đã sửa** — `Array.isArray` + `isRecord` guard (`util.ts:154`, `:159`, `:188`, `:191`), guard ở `Transcript.tsx:130/172/241/445/456`, `ToolErrorBoundary.tsx` mới bọc `ToolCardView` (`ToolView.tsx:75-77`) |
| D-GUEST-01 | P2 | `packages/guest/src/lib/socket.ts:118-120` | Queue được xả trong `ws.onopen` và xoá **trước** `onOpen?.()` → frame ứng dụng đi trước `hello` khi reconnect; cap 256 xoá im lặng | **Đã sửa** — `#helloAcknowledged` + gate gửi (`:108`), flush theo `welcome` (`:203-204`, `:249`), `send()` trả `Promise<boolean>` |
| D-GUEST-03 | P2 | `packages/guest/src/lib/socket.ts:179-193` | `4004` sau `4001` vẫn được coi là retryable → phòng đã retire bị thử lại vô hạn | **Đã sửa** — nhánh terminal `:221-227`, `retryRoom` thu hẹp còn `code === 4001` (`:228`) |
| D-GUEST-02 | P3 | `packages/guest/src/lib/link.ts:160`; `:89-93` | Parser echo nguyên chuỗi link đã gửi (chính là bearer credential) vào error hiển thị cho người dùng copy | **Đã sửa** — text tĩnh ở cả hai bản sao (`packages/guest/src/lib/link.ts:93/107/163`, `packages/collab-protocol/src/link.ts:63/77/126`) |
| API-01 | P3 | `apps/server/src/app.ts:399` | `conversationRequest.safeParse(request.body ?? {})` biến JSON `null` thành `{}` trước khi validate | **Đã sửa (vòng 3, `6b6de2f`)** — cây hiện tại `apps/server/src/app.ts:403` đọc `conversationRequest.safeParse(request.body === undefined ? {} : request.body)`: body vắng mặt vẫn nhận default, `null` tường minh bị schema strict từ chối (400). Test hồi quy `tests/server/app.test.ts:870` ("refuses a literal null body instead of starting a fresh conversation", payload `"null"` → 400 + 0 conversation) và ca song song `:888` ("still starts a conversation from an absent body and from an empty object") |
| STATIC-01 | P4 | `apps/server/src/static-web.ts:138-141` | `tryServeFile` gộp mọi lỗi open/stat/containment thành `false` → `EACCES`/`EIO` trên asset thật bị trả 404/SPA fallback | **Đã sửa (vòng 3, `6b6de2f`)** — `catch` tại `static-web.ts:138` giờ thu hẹp còn `ENOENT`/`ENOTDIR`/`ELOOP` → `false` (`:146`), mọi lỗi khác `throw` (`:147`). Test route-level: `tests/server/single-origin.test.ts:206` (web case, thêm ở `6b6de2f`) và `:237` (guest case, thêm ở `ca9a7be`) |
| TOOL-01 | P2 | `scripts/capture-screens.mjs:14` | `process.exit(result.status ?? 0)` biến `spawnSync` thất bại (`status: null`, `result.error` có) thành exit 0 | **Đã sửa** — `result.error → exit(1)` (`:16-19`), `?? 0 → ?? 1` (`:21`). **Tái hiện được bằng lệnh thật** (`exit=0`) |
| E2E-01 | P2 | `scripts/e2e-server.mjs:287` vs `playwright.config.ts:93` | SIGTERM chỉ reap tmux và cố ý không thoát, nên `child.on("exit")` (nơi xoá `tempRoot`) không bao giờ chạy trên lượt chạy bình thường | **Đã sửa** — SIGTERM giờ `child.kill("SIGTERM")` (`:289-291`) để exit handler dọn (`:300`) |
| E2E-02 | P3 | `playwright.config.ts:34` vs `scripts/e2e-server.mjs:303` | Config quảng cáo `join(tmpdir(), "caw-e2e-fixture.json")` còn launcher ghi `join(tempRoot, "fixture.json")` — đường dẫn được quảng cáo không được ghi cũng không được xoá | **Đã sửa** — launcher dùng cùng default (`:319-320`) và xoá manifest trong exit handler (`:302-306`) |
| ACTIVITY-01 | P3 | `ActivityPanel.tsx:80-81`, `:112-113` | `setLoading(false)`/`setLoadingMore(false)` chạy trước kiểm tra generation → read bị thay thế xoá spinner của read mới hơn | **Đã sửa** — mỗi entry point giữ generation riêng (`:70`, `:71`), release theo owner (`:91`, `:117`, `:138`) |
| TOOL-02 | — | `scripts/e2e-server.mjs:198-209` | Bị báo là vi phạm rule-1 (canary `#!/bin/sh` tự sinh) | **Bác bỏ (INVALID_FINDING)** — canary là *file ghi xuống đĩa* cho kernel tra PATH, không phải process con; cả hai điểm spawn trong file dùng array argv + `shell: false` (`:235`, `:262`). Không sửa |
| COMPOSER-01 | P2 | `packages/guest/src/components/shell/Composer.tsx:151-157` (vị trí ở cây vòng 2 — defect **không tồn tại** ở HEAD `26874b0`; `send` ở baseline là `:148-153`) | Xoá draft chỉ khi delivery được chấp nhận (fix F13/D-GUEST-02) đã bỏ mất re-entry guard ngầm: hai lần Enter trước khi frame đầu settle xếp cùng prompt hai lần — regression do chính fix đó gây ra, tệ hơn HEAD | **Đã sửa (vòng 3)** — `sendingRef` in-flight (`Composer.tsx:137` khai báo, `:159` early return, `:181` release trong `finally`). Test `tests/guest/round27-composer-draft.test.tsx:110` ("sends exactly one prompt when Enter is pressed twice before the send settles") và `:137` |

Tổng hợp trạng thái (tại `ca9a7be`): **16 dòng `CONFIRMED`, cả 16 đã được sửa và kiểm chứng được
bằng thay đổi trong cây** — 13 dòng vòng 1 (`RUNTIME-01`, `WEB-01`, `WEB-02`, `RENDER-01/02/03`,
`D-GUEST-01/02/03`, `TOOL-01`, `E2E-01/02`, `ACTIVITY-01`), `API-01`/`STATIC-01` sửa ở vòng 3
(`6b6de2f`), và `COMPOSER-01` cũng ở vòng 3; cộng **1 dòng bác bỏ** (`TOOL-02`,
`INVALID_FINDING`) = 17 dòng. Không dòng nào còn ở trạng thái "không xác nhận được" hay "từ chối
sửa".

Các finding vòng trước (`F00–F13`, `R01–R03`) không nằm trong 17 dòng trên; phân loại chúng ở
`F-series.md`. Tóm tắt lượt đó: CONFIRMED còn mở tại HEAD là `F00` (trùng RUNTIME-01), `F01`, `F03`
(chỉ `apps/web`), `F06`, `F07` (trùng ACTIVITY-01 ở `ActivityPanel`), `F08` (trùng WEB-01), `F10`,
`F11` (nửa `packages/guest`), `F13`, cộng `R02` (trùng RENDER-02) và `R03`. Trong đợt sửa này
`F01` (restart trung thực), `F03` (nút Cancel cho approval), `F06`/`F07` (single-flight delete +
ownership cờ loading), `F10` (Stop báo lỗi khi không gửi được), `F13` (giữ draft guest) đều đã có
thay đổi + test mới; `R03` được xử lý ở tầng tài liệu
(`docs/operations/acceptance-run-plan.md`, +30/−3).

## 3. Bảng cổng kiểm tra

Sao từ `audit/regression-results.md` (cổng 1–7, lần chạy **đầu**) và `audit/final-gates.md` (lần chạy
**cuối** trên cây đã đủ fix, trước commit). Ngày chạy 2026-10-31. Bảng dưới trích **lần chạy cuối**
trừ khi ghi rõ; cổng 1–7 giống nhau về kết luận giữa hai lần, chỉ số test/E2E dịch chuyển vì vòng 2
và vòng 3 thêm file. `git status --porcelain` giống hệt nhau trước và sau toàn bộ cổng.

| # | Cổng | Lệnh (đúng như đã chạy) | Kết quả quan sát nguyên văn | Kết luận |
|---|---|---|---|---|
| 1 | Typecheck toàn bộ package | `pnpm -r typecheck` | exit `0`; `Scope: 8 of 9 workspace projects`; 8× `<pkg> typecheck: Done` | **PASS** (8/8 package có script typecheck) |
| 2 | Đếm diagnostic tsc gốc repo | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json \| grep -c "error TS"` | **`144`** (baseline HEAD export = `153`; brief nói ~87) | **PASS theo ngưỡng sweep** (0 < 144 < 200), **nhưng số đã dịch chuyển**: cao hơn brief, thấp hơn HEAD. Đây **không** phải cổng CI |
| 3 | Unit/integration/web suite (lần đầu, `regression-results.md`) | `TMPDIR=/var/tmp/caw-tmp node node_modules/vitest/vitest.mjs run --maxWorkers=8 --reporter=dot` | `Test Files  127 passed \| 2 skipped (129)` / `Tests  878 passed \| 8 skipped (886)` | **PASS** (0 fail) — **số lịch sử**, chạy trước vòng 2/3 |
| 3′ | Unit/integration/web suite (lần cuối, `final-gates.md`) | cùng lệnh | `Test Files  132 passed \| 2 skipped (134)` / `Tests  915 passed \| 8 skipped (923)` | **PASS** (0 fail, exit 0) |
| 3″ | Unit/integration/web suite tại `ca9a7be` (commit cuối) | cùng lệnh, trên CI job `verify` | **`916 passed`** / 8 skipped (CI run `41183496042`, bước "Tests (unit, integration, web)" `success`) | **PASS** — số **sau commit**, bởi `ca9a7be` thêm 1 test server |
| 4a | Build toàn bộ package | `pnpm -r build` | exit `0`, cả 8 project `Done` | **PASS** |
| 4b | Build guest client | `node scripts/build-guest.mjs` | exit `0`; `[build-guest] built guest client in 242ms` (lần đầu) / `286ms` (lần cuối) | **PASS** |
| 5 | Compat probe (không spawn gì) | `node scripts/compat-check.mjs` | exit `0`; `17 ok, 1 warn, 0 fail`; warn = `collab list --json shape — version=1 hosts=0` | **PASS** (0 fail; warn là điều kiện môi trường, không phải defect) |
| 6 | Browser E2E Chromium, viewport mobile (lần đầu/`final-gates.md`) | `TMPDIR=$HOME/.cache npx playwright test --project=chromium --workers=1 --retries=0` | `76 passed (1.5m)`, 13 spec file, 0 skipped, 0 flaky | **PASS** (chỉ Chromium) — chạy ở cây trước `ca9a7be` |
| 6′ | Browser E2E Chromium tại `ca9a7be` (7 viewport) | cùng lệnh | `--list` = `Total: 78 tests in 13 files`; suite chạy = **78 passed** (CI run `41183496042`, bước "Browser E2E (Chromium, mobile viewport)" `success`) | **PASS** — 7 viewport, phủ đủ 6 viewport mission |
| 6b | Browser E2E WebKit | (không chạy; project bị config bỏ) | `~/.cache/ms-playwright` chỉ có `chromium-1248`, `chromium_headless_shell-1248`, `ffmpeg-1013` — không có bundle `webkit-*` | **SKIP — KHÔNG phải PASS** |
| 7 | Khẳng định bundle không có origin lạ | `if grep -rIl "um\.can\.ac\|my\.omp\.sh" apps/web/dist packages/guest/dist; then echo DIRTY; else echo clean; fi` | `clean` | **PASS** |

**Số nào là thật, cái nào SKIP — nói thẳng:**

- Thật (chạy và có output): cổng 1 (exit 0, 8 package), cổng 3′ (915 test pass, lần cuối) và 3″
  (916 test pass, đọc từ CI ở `ca9a7be`), cổng 4a/4b, cổng 5 (17 ok / 1 warn / 0 fail — chỉ là probe,
  **không** spawn agent), cổng 6/6′ (76 rồi 78 Chromium), cổng 7.
- Cổng 3 (878) là số **thật nhưng lịch sử**: chạy trong lượt gate đầu, trước khi vòng 2 và vòng 3
  thêm file test. Đừng trích nó như số cuối.
- Cổng 2 là số thật nhưng **không phải cổng CI** và đã dịch chuyển so với brief (144 ≠ ~87). 124/144
  diagnostic nằm ở file lượt này **không** chạm; 7 trong 55 diagnostic của `packages/guest` là
  `TS2307` do project gốc không có alias `@oh-my-pi/pi-wire` — nhiễu hợp lệ về mặt cấu trúc, không
  phải lỗi kiểu mới. Đo kiểm soát: `git archive HEAD` export ra `/var/tmp` → **153**, tức lượt sửa
  giảm 9 diagnostic so với HEAD.
- **SKIP (không phải pass):** cổng 6b WebKit; và bên trong cổng 3, gói compat thật-OMP (8 test, 2 file
  `tests/compat/*`) bị skip theo thiết kế vì `CAW_COMPAT !== "1"`.

Cổng fail: không. Cổng skip: WebKit E2E + suite compat thật-OMP.

Sổ tác dụng phụ (từ `regression-results.md`): `tests/e2e/screens.spec.ts` ghi lại
`docs/assets/screens/*.png` — đã `git checkout -- docs/assets/screens` để hoàn nguyên (84 PNG, path
hiện sạch); tmux socket `cawtest-…`/`cawtri-…` của lượt chạy đã được xác nhận chết rồi `rm` bằng tên
cụ thể (không `kill-server` trần, không `pkill`, không glob); 361 socket tmux có sẵn của hệ thống
trong `/tmp/tmux-1000/` không bị đụng; `omp` không bao giờ được launch; scratch `/var/tmp/r27-head`
đã xoá.

## 4. Việc KHÔNG chạy được

| Hạng mục | Trạng thái | Vì sao |
|---|---|---|
| **WebKit / Safari / iOS rendering** | **KHÔNG CHẠY** | Không có bundle `webkit-*` trong `~/.cache/ms-playwright`; `playwright.config.ts:56` bỏ hẳn project WebKit trên máy này. `npx playwright test --list` = `Total: 78 tests in 13 files` (tại `ca9a7be`), không dòng nào khớp `webkit`. **Đừng đọc 78/78 như cross-browser.** |
| **Compat thật (OMP + tmux thật)** | **KHÔNG CHẠY** | `CAW_COMPAT` không được set, nên `tests/compat/*` (8 test) skip. Đó là những test chứng minh supervisor điều khiển được cặp `omp`+`tmux` thật; chúng spawn agent và tốn credit provider. CI chạy riêng ở job `workflow_dispatch` và **chưa từng được dispatch**. |
| **iPhone thật** | **KHÔNG CHẠY** | Checklist 10 dòng trong `docs/operations/acceptance-run-plan.md` tự đánh `UNVERIFIED`, không có đường code nào. Config Playwright mặc định một viewport Chromium 390×844 (`playwright.config.ts:18`) và spec `mobile.spec.ts`/`conversation.spec.ts` pin cứng 390 trong assertion; `ca9a7be` thêm sweep ảnh 7 viewport (`375x667`, `375x812`, `390x844`, `430x932`, `768x1024`, `1280x800`, `1440x900`) nhưng **vẫn là Chromium**, không phải iOS Safari. Không có thiết bị thật nào chạy. |
| **Acceptance thật cần agent trả phí** | **KHÔNG CHẠY trong lượt này** | `scripts/acceptance-ui-drives-agent.mjs` launch agent thật và tiêu credit; không agent nào chạy nó. Ngoài ra lượt F-series phát hiện script định nghĩa 15 check nhưng **SKIP không bao giờ làm run fail** (`:39`), run không có `--password` chỉ chạy `check1` (`:2166-2168`), và check phụ thuộc model/approval skip im lặng — nên "15 check tồn tại" ≠ "15 kịch bản đã được xác minh". Ba dòng claim trong kế hoạch được ghi là **quan sát, không khẳng định** và một dòng lệnh Tier-4 (`--token-file`) là **stale** (cờ không tồn tại trong script). |
| **Fault injection HTTP / EACCES trên asset thật** | **ĐÃ CHẠY ở tầng test (vòng 3)** | `API-01` và `STATIC-01` giờ có test route-level thật: `tests/server/single-origin.test.ts:206`/`:237` `chmod 0o000` một asset thật rồi `app.inject` và khẳng định 500 (`error.code: "internal"`), và `tests/server/app.test.ts:870` gửi body `"null"` thật → 400. Không mock `node:fs/promises.open`; đây là `chmod` + inject thật, không phải fault-injection ở tầng syscall. |
| **Coverage instrumentation** | **KHÔNG CHẠY** | Không agent nào chạy coverage; do đó tài liệu này **không** đưa ra khẳng định coverage theo file. |
| **`pnpm -r typecheck` thứ hai trong lượt hậu sửa** | **KHÔNG CHẠY** (bởi `postfix-auditor`) | `independent-review.md` ghi rõ: peer `verify-gates` đang chạy lệnh đó và đĩa ở 99%, nên nó không khởi động `tsc` đệ quy thứ hai. Thay đổi chữ ký `send()` vì vậy **không** được nó xác minh ở tầng kiểu; cổng 1 của lượt gate là nguồn của khẳng định đó. |
| **Hosted CI** | **ĐÃ đối chiếu** | Commit/push đã diễn ra sau lượt audit này. Ba run `CI` cho cây sửa, đọc từ GitHub Actions API bằng `curl`: `41181539376` `failure` (`5fc70ba`, bước "Tests (unit, integration, web)"), `41181987966` `success` (`b5a104a`), `41183496042` `success` (`ca9a7be`, job `verify` xanh gồm cả unit/integration/web và E2E Chromium). Job `compat` `skipped` (opt-in `workflow_dispatch`, chưa dispatch). |
| **Ảnh PNG/visual** | **KHÔNG mở** | F-render và D-guest đều nói không mở ảnh; không có pixel review. |

## 5. Residual risks

### 5.1 Sáu defect do chính đợt sửa gây ra (D1–D6) — lượt hậu sửa tìm ra, cây hiện tại đã sửa

| ID | Nội dung | Mức bằng chứng | Trạng thái trong cây hiện tại |
|---|---|---|---|
| D1 | `ActivityPanel.tsx` — `loadingMore` thuộc một read mà effect đổi hội thoại không hề supersede: "Load older" bị disable trên hội thoại mới cho tới khi trang bị bỏ rơi settle | **REPRODUCED** (jsdom, `tests/web/zz-auditor-probe-lm2.test.tsx`: `PROBE c2 Load-older click issued calls: 0`) | Đã sửa: effect đổi hội thoại bump + release `pageGenerationRef` (`:116-117`); test `tests/web/round28-activity-loadmore.test.tsx` |
| D2 | `ProjectsView.tsx` — 404 bị báo là thành công cho project người dùng chưa từng xoá; guard được nhả một microtask trước khi đọc kết quả | **REPRODUCED (test) + lập luận nguồn**; phần second-order **UNDETERMINED** | Đã sửa: dung sai 404 chỉ khi có `deletedProjects.has(projectId)` (`:52-64`, `:491`), guard giữ tới khi đọc kết quả (`:478-505`) |
| D3 | `ModalOverlay.tsx` — Escape/Tab gắn vào subtree overlay, nên click thật vào text của dialog đẩy focus về `<body>` và Escape ngừng tác dụng | **REPRODUCED trong Chromium thật** (`activeAfterParagraphClick":"BODY"`, `escapeAfterParagraphClick":{"closes":0,"open":true}`) | Đã sửa: keydown gắn vào `document` khi mount, gỡ khi unmount (`ModalOverlay.tsx:114`); test `tests/web/round28-modal-escape.test.tsx` |
| D4 | `socket.ts` — `send()` trả `true` cho frame mới chỉ được queue, rồi mọi nhánh terminal vứt queue: fix giữ draft của composer không kích hoạt | **REPRODUCED** (`send() returned = true` / `frames ever sent on connection 2 (hello + flushed queue): 1`) | Đã sửa: `#discardPending` settle từng frame bị bỏ là `false` (`:270-273`), `#pendingSends` mang theo `settle`; test `tests/guest/round28-socket-queue-honesty.test.ts` |
| D5 | `socket.ts` — gate handshake mở theo `welcome` **của host**, nên phòng được tạo lại sau 4001 không thể vào lại khi queue đầy | **REPRODUCED (cơ chế) / UNDETERMINED (tần suất)** — `connection 2 frames after open (hello only, queue NOT flushed): 1`; `accepted trues: 256 \| falses: 44` | Hệ quả có chủ đích của fix D-GUEST-01. Queue bị chặn bởi `MAX_PENDING_SENDS = 256` (`:27`) và frame thứ 257 bị **từ chối**, không giết socket (`:115`). Liệu host OMP thật có tạo lại phòng trong 256 frame xếp hàng hay không: **chưa đo** |
| D6 | `link.ts` — fix landing trên bản sao **không chạy** (`packages/guest/src/lib/link.ts`) trong khi bản được `ConversationView.tsx:879` import (`@caw/collab-protocol`) vẫn nội suy credential đã gửi | **REPRODUCED (nguồn)** | Đã sửa: cả hai bản sao trả text tĩnh (`packages/collab-protocol/src/link.ts:63/77/126`) |

Hai finding của lượt hậu sửa đã bị **rút lại** và vẫn được ghi nhận thay vì xoá: (a) "`joinedRoom`
đọc status của socket trước" — hoá ra là artifact của mock `connect` không set `#ws`; với `close()`
trung thực thì nhánh đúng được chọn và fix restart là **sound**; (b) "`conversationAtRestart` không
được khai báo" — sai, nó được khai báo ở `ConversationView.tsx:1137`; lần grep trước đọc buffer bị
cắt bởi selector có offset rơi qua chỗ khai báo.

### 5.2 "Incomplete sibling" còn lại

| Sibling | Kết luận của lượt hậu sửa / đối kháng | Trạng thái |
|---|---|---|
| `packages/guest/src/lib/socket.ts` D4/D5 (queue + tần suất) | D4 đã đóng; D5 — phòng tạo lại sau 4001 giờ đợi `welcome` mà không có host nào gửi, nên queue có thể cạn 256 trước khi phòng quay lại | **Mở có chủ đích** — cần số đo thật về nhịp host OMP tạo lại phòng |
| `Transcript.tsx:139` (`data:` thumbnail bỏ qua policy raster) | Adversarial: "fix as shipped is incomplete against its own rationale"; đo được **không** scriptable (`<img src="data:image/svg+xml,…">` không bao giờ chạy script) | **Đã đóng trong cây hiện tại** (`isRasterImageMime` ở `:137`, note ở `:145`) |
| `packages/guest/src/lib/link.ts:106` (`${url.protocol}`) | Adversarial: "Not yet touched … one line to close while the file is already in flight" | **Đã đóng trong cây hiện tại** (`:107` trả text tĩnh) |
| `state.ts` nhánh external — `statusDetail` | "Consistent states, inconsistent explanations": state đúng (đều qua `hostState`), nhưng nhánh external báo vấn đề relay cho vấn đề busy-flag và ngược lại | **Mở, không phải claim defect** — cây hiện tại ghép ownership + turn + relay note ở cả nhánh managed (`:173-180`) và external (`:99-114`), `supervisor.ts:999` cũng vậy; không test nào pin khác biệt wording còn lại |
| `Markdown.tsx:86` (`safeSrc` cho phép `data:image/svg+xml;base64,…`) | "a second, different allowlist in the same package" — renderer khác, `<img src>` SVG không phải tài liệu top-level scriptable | **Mở có chủ đích**, ngoài phạm vi ticket |
| `ProjectsView.tsx:582` / `ProjectDetailView.tsx:154` guard `event.target !== event.currentTarget` | Chromium AX probe: nested button vẫn lộ trong card `role="button"` — "an `aria-allowed-role` nesting question for an axe pass rather than a defect I could demonstrate" | **Mở** — cần một lượt axe; `ProjectDetailView`'s guard là dead nhưng vô hại |
| Boundary lỗi `ToolErrorBoundary` | Chỉ bắt throw pha render; `ToolView.tsx:79-83` chỉ bọc `ToolCardView`; throw async không bị bắt nhưng renderer hiện không có I/O async | **Mở, không truy cập được từ renderer hiện tại** |

### 5.3 Điều chưa chứng minh được

- **`relayConnected: false` + `busy: true` chưa từng được quan sát end-to-end.** Lượt đối kháng:
  cặp này "không structurally impossible" nhưng "reachability is plausible but **not exercised
  end-to-end** — no captured host row with `relayConnected:false, busy:true` exists in this repo".
  Severity của RUNTIME-01 giữ nguyên chỉ dưới hội chứng chưa được chứng minh đó. `docs/operations/evidence.md:39`
  có ghi một lượt launch thật publish với `relayConnected: false`, nhưng không kèm cờ busy.
- **CSP chỉ được đo trên Chromium.** Mọi phát biểu "blocked/allowed" của lượt đối kháng (RENDER-01,
  RENDER-02) là **Chromium-only** và được dán nhãn như vậy; WebKit không thể chạy vì chỉ có Chromium
  được cài. Kết luận "CSP vô hiệu hoá RENDER-02" chỉ đúng cho payload tự chứa: dưới meta CSP nghiêm,
  một blob SVG/HTML chứa `<script href="http://<same-origin>/evil.js"/>` **vẫn chạy**
  (`title = SAMESITE_EXT_EXEC`). Nó thành primitive tiềm ẩn chứ không phải khai thác sống, vì repo
  không có tài nguyên JS same-origin nào do kẻ tấn công kiểm soát (relay phục vụ file tĩnh, API phục
  vụ JSON) — nhưng **không được viết xuống là "SVG script không chạy được ở đây"**.
- **D-GUEST-01: hệ quả "host vứt frame" là suy luận chưa kiểm chứng.** Relay là content-blind và
  **không** vứt frame (`relay.ts:339-345`); `host.ts` của OMP không có trong repo. Cái đã chứng minh
  là guest gửi frame ứng dụng trước khi biết peer tồn tại.
- **Lượt hậu sửa không chạy typecheck** (`send()` đổi chữ ký chưa được xác minh ở tầng kiểu bởi nó),
  **không chạy browser E2E trên app đã build** (D1/D2/D4 lái bằng jsdom + test double; D3 lái trong
  Chromium thật nhưng trên **replica độc lập** của contract `ModalOverlay`, không phải SPA đã build),
  và **không lái được cửa sổ vi mô** của D2 second-order (`UNDETERMINED`).
- **Số test "đã skip" là 8, không phải "đã pass".** Gói compat thật-OMP chưa từng chạy trong lượt này
  và job CI của nó chưa từng được dispatch.
- **Đĩa `/` ở 99% (2,3 GB trống)** suốt lượt chạy gate. Không cổng nào fail vì dung lượng, nhưng
  cổng 6 ghi vào `$HOME/.cache` (cùng filesystem) — biên thấp hơn có thể lật cổng 4, 6 hoặc 7.
- **Số trong cổng 2 (144) không có baseline được commit trong repo**; con số 153 là phép đo kiểm soát
  của chính lượt gate. Brief nói ~87 nhưng không tìm được nguồn nào trong cây.
- **Ba finding từng không xác nhận được trạng thái sau sửa, giờ đã rõ**: `API-01` và `STATIC-01` —
  bản đầu ghi "ledger nói yes nhưng cây không đổi"; **sai ở thời điểm `ca9a7be`** — cả hai đã sửa ở
  vòng 3 (`6b6de2f`) và có test route-level (xem §2). `TOOL-02` vẫn **bác bỏ** (`INVALID_FINDING`,
  không sửa).

## 6. Kết luận

**Không khẳng định đã hết bug.** Lượt này đọc trọn 70/140 file first-party (50,0%), xem phần dải
39,4% còn lại và **chưa từng mở** 25 file; 24.595 dòng test chỉ được grep chứ không đọc từng dòng;
`apps/web` (nơi sinh ra WEB-01, WEB-02, ACTIVITY-01) và `packages/collab-protocol` (bản sao giữ
credential của D6) đều có **0** file fully-read — 17 và 6 file tương ứng chỉ được đọc một phần.
Không có khẳng định nào về coverage theo file. `API-01` và `STATIC-01` **đã có fix trong cây**
(`6b6de2f`), mỗi fix có test hồi quy — bản đầu của tài liệu này viết sai điều đó vì được soạn trước
vòng 3.

**Điều đã chứng minh được:**

1. **17 dòng ledger được phân loại và có bằng chứng cho từng dòng.** 7 dòng tái hiện bằng probe đã
   chạy thật (RUNTIME-01, RENDER-01, RENDER-02, D-GUEST-01, D-GUEST-03, TOOL-01, `COMPOSER-01`) —
   trong đó 4 dòng bằng lượt đối kháng (probe thật: `ws` server thật + AES-GCM thật cho socket;
   Chromium thật cho CSP), 1 dòng bằng lệnh `PATH=/nonexistent → exit=0`, và `COMPOSER-01` bằng đo
   `{ promptsSent: 2, texts: ["hello","hello"] }` ở lượt tái-tấn-công. 1 dòng bị bác bằng grep đã
   chạy (TOOL-02). **9 dòng còn lại là source-derived** và được ghi đúng như vậy, không giả vờ đã
   chạy.
2. **16 dòng có thay đổi trong cây**, mỗi dòng kèm file:line trước/sau, và mỗi dòng có test hồi quy
   trừ `TOOL-01` (không có test nào phủ `scripts/capture-screens.mjs`).
3. **Cổng xanh trên cây cuối**: typecheck 8/8 package, `915 passed | 8 skipped | 0 failed` trên máy
   (`final-gates.md`) và **`916 passed | 8 skipped`** đọc từ CI ở `ca9a7be`, build toàn bộ package +
   guest, `compat-check` 17 ok / 1 warn / 0 fail, Playwright Chromium **78/78** trên **7 viewport**
   (lần chạy máy cuối: 76/76 trên 5 viewport; `ca9a7be` thêm 2), bundle assertion `clean`, CI run
   `41183496042` = `success`.
4. **Lượt hậu sửa tự tìm ra 6 defect do chính đợt sửa gây ra (D1–D6)** và cả 6 đã được sửa trong cây,
   mỗi cái có test mới; hai finding của chính nó bị rút lại và vẫn được ghi nhận công khai.
5. **Cổng 2 giảm 9 diagnostic so với HEAD** (153 → 144), tức lượt sửa không đưa thêm lỗi kiểu vào
   project gốc.

**Điều chưa chứng minh được:** ca `relayConnected:false` + `busy:true` chưa từng được quan sát
end-to-end; toàn bộ phát biểu CSP là Chromium-only (WebKit chưa chạy, chưa có bundle); hệ quả
"host vứt frame" của D-GUEST-01 là suy luận về OMP, không có trong repo; tần suất phòng tạo lại sau
4001 nằm trong cửa sổ 256 frame chưa đo (D5); cửa sổ vi mô second-order của D2 chưa lái được; gói
compat thật-OMP và WebKit đều **SKIP** chứ không phải pass; iPhone thật và acceptance thật cần agent
trả phí **chưa chạy**; không có instrumentation coverage nên không có khẳng định coverage theo file.
`API-01` và `STATIC-01` **đã có fix trong cây** và test hồi quy — không còn nằm trong danh sách này.

**Điểm mù về nguồn lực, ghi để vòng sau xử lý:** `ACTIVITY-01` — một dòng ledger P3 — **không** xuất
hiện trong bất kỳ file findings khu vực nào (`grep -rn "ACTIVITY-01"` chỉ khớp ledger và diff của
bản sửa); không rõ agent nào tìm ra và **không có lệnh nào từng chạy** cho nó. Nó vẫn được sửa và có
test, nhưng bằng chứng phát hiện thì chưa bao giờ tồn tại.

## 7. Vòng 2 và vòng 3 (sau bản đầu của tài liệu này)

Bản đầu của tài liệu này dừng ở vòng sửa thứ nhất. Sau đó một lượt hậu sửa độc lập
(`audit/independent-review.md`) và một lượt tái-tấn-công (`audit/reverify.md`) tìm thêm defect, và
cả hai vòng đã được sửa trên cây. Ghi lại ở đây thay vì giả vờ chúng chưa từng xảy ra.

### 7.1 Vòng 2 — sáu defect do chính đợt sửa gây ra (D1–D6)

Chi tiết đầy đủ ở §5.1. Cả sáu đã sửa trong cây, mỗi cái có test mới:
`round28-activity-loadmore` (D1), `round28-project-delete-404` (D2), `round28-modal-escape` (D3),
`round28-socket-queue-honesty` (D4/D5), `round28-link-secrecy` (D6).

### 7.2 Vòng 3 — N1–N4

| ID | Nội dung | Trạng thái trong cây hiện tại |
|---|---|---|
| **N1 (HIGH) — `COMPOSER-01`** | Fix giữ draft ở vòng 2 ("chỉ xoá draft khi biết chắc đã gửi") đã bỏ mất re-entry guard ngầm: `canSend` vẫn `true` suốt round trip nên hai lần Enter (hoặc Enter + click Send) xếp **cùng một prompt hai lần**. Đo được: `{ promptsSent: 2, texts: ["hello","hello"] }` — tệ hơn HEAD | Đã sửa: `sendingRef` in-flight (`Composer.tsx:137`, `:159`, `:181`); test `tests/guest/round27-composer-draft.test.tsx:110`, `:137`. Xem thêm dòng `COMPOSER-01` ở §2 |
| **N2 (MEDIUM)** | Tab-trap của `ModalOverlay` không phủ `<body>`, nên `Shift+Tab` từ đúng trạng thái mà fix D3 nhắm tới lại đi **ngược ra ngoài modal**; người dùng bàn phím chạm được `Rename`, mở chồng dialog thứ hai, và **một lần Escape đóng cả hai** | Đã sửa: trap coi "focus không nằm trong container" là biên (`ModalOverlay.tsx:133`, `:136`), và một stack module-level chỉ cho dialog trên cùng trả lời Escape (`:28`, `:110`). Test `tests/web/round28-modal-escape.test.tsx:73` (Shift+Tab từ `<body>`), `:99` (Tab tiến từ `<body>`), `:119` ("lets only the topmost dialog answer Escape") |
| **N3 (LOW / latent) — KHÔNG sửa** | `hello` khi reconnect được miễn gate `#helloAcknowledged` nhưng **không** miễn `MAX_PENDING_SENDS = 256`, nên nếu có caller gửi `hello` lúc đang ngắt kết nối với queue đầy thì chính handshake bị từ chối và `#flushPending()` (chỉ chạy được từ `welcome` đến) không bao giờ chạy | Không truy cập được từ hai caller production hiện tại — cả hai gửi `hello` trong `onOpen` khi socket đã `OPEN`. Ghi lại như **coded hazard kèm trigger**, không âm thầm bỏ. `tests/guest/round28-socket-queue-honesty.test.ts` có phủ; queue chặn ở `socket.ts:27`, frame thứ 257 bị từ chối (`:115`) |
| **N4 (LOW)** | Đường reconcile của `supervisor.ts` vẫn ghi "it can be watched" cho host external có relay reachability **không xác định** (`relayConnected === null`) — đúng cái over-claim vòng 2 đã bỏ cho `relay=false`. `relayConnected: null` là giá trị thật trên đường này (`packages/omp-adapter/src/collab-registry.ts:70` ánh xạ mọi field không boolean thành `null`) | Đã sửa: `ownershipNote`/`relayNote` phân biệt `null` với `false` (`supervisor.ts:1006-1020`) → "whether it can be watched is unconfirmed" (`:1015-1020`). Test `tests/runtime/supervisor.test.ts:1814` |

### 7.3 Chín test không thể fail (W1–W9)

`audit/reverify.md` liệt kê chín test vòng 2 mà assertion đúng bất kể sản phẩm làm gì. Từng cái đã
được thay/thắt lại; ví dụ đã kiểm lại trong cây:

- **W3** — `expect(tabbables().length).toBeGreaterThan(2)` (positive control cả document, không bao
  giờ fail) → `tests/web/a11y-modals.test.tsx:108` giờ là `toBeGreaterThan(inside.length)`.
- **W7** — suite composer chưa bao giờ bấm Enter hai lần khi đang gửi → `tests/guest/round27-composer-draft.test.tsx:110`.
- **W8/W9** — số lần gọi + shape call cuối, mutation bỏ payload guard không thấy → `tests/web/round28-activity-loadmore.test.tsx:44-77` khẳng định đúng các dòng được render (`#30`, `#28`, **không** `#10`) và cursor đã dùng (`["c2", { before: 28 }]`); W8 case ở `:79`.
- **W1** — `tests/web/round28-modal-escape.test.tsx:178` spy `addEventListener`/`removeEventListener` và khẳng định **đúng handler đó** đã gỡ.
- **W4** — `tests/web/f06-f07-project-guards.test.tsx:139-160` khẳng định dòng đã xoá biến mất khỏi màn hình (`:157`).

Danh sách đầy đủ W1–W9 ở `audit/fixes.md` và `audit/reverify.md`.

### 7.4 CI fail trên push đầu và cách sửa

Push đầu của đợt sửa (`5fc70ba`) làm CI run `41181539376` fail ở bước "Tests (unit, integration,
web)". Nguyên nhân: fix teardown E2E thêm `tests/server/round26-e2e-harness-cleanup.test.ts`, test
này mở đầu bằng việc khẳng định `apps/web/dist/index.html` tồn tại và throw nếu không — nhưng tầng
unit/integration không chạy build, nên trên CI file vắng và test fail trước khi test được gì.

`b5a104a` sửa bằng cách cho precondition asset của launcher tôn trọng `CAW_WEB_DIST_DIR`
(`scripts/e2e-server.mjs:26-33`) và trỏ test harness vào một `apps/web/dist` stub (`mkdtempSync`).
CI run `41181987966` sau đó `success` trên `b5a104a`; run cuối `41183496042` `success` trên `ca9a7be`.

### 7.5 File test thêm/sửa trong hai vòng

`git diff --name-status --diff-filter=A 26874b0..ca9a7be -- tests/` → **16 file test MỚI**:
`tests/guest/round27-{collab-transport,composer-draft,render-safety}`, `tests/guest/round28-socket-queue-honesty`,
`tests/protocol/round28-link-secrecy`, `tests/server/round26-e2e-harness-cleanup`,
`tests/web/{a11y-modals,f06-f07-project-guards,round27-approval-cancel,round27-restart-honesty,round27-startup-taxonomy,round27-stop-send,round28-activity-loadmore,round28-modal-escape,round28-project-delete-404,web02-keyboard-nav}`.
Cộng **7 file test bị sửa**: `tests/e2e/{README.md,screens.spec.ts}`, `tests/runtime/{state,supervisor}.test.ts`,
`tests/server/{app,single-origin}.test.ts`, `tests/web/round25-conversation-metadata-auditor.test.tsx`.
Tổng thay đổi trong cả hai commit cuối: `54 files changed, 4091 insertions(+), 182 deletions(-)`.
