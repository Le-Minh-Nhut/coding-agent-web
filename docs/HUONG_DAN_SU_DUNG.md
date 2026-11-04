# Hướng dẫn sử dụng Coding Agent Web

Tài liệu dành cho người mới dùng Coding Agent Web (CAW) trên Ubuntu cá nhân và điều khiển bằng iPhone. Mô tả hành vi đang có thể kiểm tra trong mã nguồn và tài liệu vận hành; giao diện có thể được cập nhật trong quá trình phát triển.

## Mục lục

1. [Giới thiệu](#1-giới-thiệu)
2. [Truy cập từ điện thoại](#2-truy-cập-từ-điện-thoại)
3. [Projects](#3-projects)
4. [Conversations](#4-conversations)
5. [History](#5-history)
6. [Giải thích mọi trạng thái](#6-giải-thích-mọi-trạng-thái)
7. [Phân biệt các thao tác](#7-phân-biệt-các-thao-tác)
8. [Sử dụng cùng một conversation trên Ubuntu và iPhone](#8-sử-dụng-cùng-một-conversation-trên-ubuntu-và-iphone)
9. [Công cụ và giao diện chat](#9-công-cụ-và-giao-diện-chat)
10. [Lệnh `/handoff` — nén ngữ cảnh tại chỗ](#10-lệnh-handoff--nén-ngữ-cảnh-tại-chỗ)
11. [Giới hạn và bảo mật](#11-giới-hạn-và-bảo-mật)
12. [Troubleshooting](#12-troubleshooting)
13. [FAQ](#13-faq)

## 1. Giới thiệu

CAW là giao diện web riêng tư để điều khiển các coding agent OMP đang chạy trên laptop Ubuntu. OMP thực hiện công việc và chạy công cụ trên laptop; CAW cung cấp danh sách project, conversation, transcript và giao diện chat. CAW không thay OMP, không lưu thông tin đăng nhập nhà cung cấp AI thay OMP và không chạy agent trên iPhone.

Laptop chạy server, OMP, tmux và tiến trình agent. Tmux giúp agent tồn tại độc lập với tab trình duyệt. iPhone chạy Safari hoặc PWA để đăng nhập, gửi prompt, xem hoạt động và điều khiển qua mạng.

Trên máy này, ứng dụng web/API nghe tại `127.0.0.1:8791`; Collab relay riêng nghe tại `127.0.0.1:8792`. Tailscale Serve cung cấp HTTPS nội bộ tailnet và chuyển tiếp tới cổng 8791. Cả laptop và iPhone phải kết nối cùng tailnet. Chỉ proxy cổng 8791; không proxy cổng relay 8792 và không bật Tailscale Funnel.

Tài liệu liên quan: [kiến trúc vòng đời session](architecture/session-lifecycle.md), [mô hình bảo mật](architecture/security-model.md), [cài đặt Ubuntu](operations/ubuntu-setup.md), [truy cập iPhone](operations/iphone-access.md), [thiết lập và dùng iPhone](operations/iphone-setup.md).

## 2. Truy cập từ điện thoại

1. Kết nối Tailscale trên laptop và iPhone, đăng nhập cùng tailnet. Trên laptop kiểm tra bằng `tailscale status`.
2. Mở Safari trên iPhone và truy cập [https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net](https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net). Dùng đúng HTTPS, không thêm cổng. Tùy chọn: trong Safari chọn Chia sẻ → Thêm vào Màn hình chính để cài PWA.
3. Đăng nhập bằng mật khẩu CAW. Ở lần khởi động đầu, server in ra stdout **đường dẫn** tệp setup token cùng lệnh `cat` để đọc; server **không in token**. Trên máy này, tệp là `/home/heheboiz/.local/state/coding-agent-web/setup-token`. Lệnh đọc trên máy này:

   ```bash
   cat /home/heheboiz/.local/state/coding-agent-web/setup-token
   ```

   Token dùng một lần, hết hạn sau 15 phút. Nhập token ở màn hình đăng nhập rồi đặt mật khẩu ít nhất 12 ký tự.
4. Nếu không mở được web, kiểm tra Tailscale, Serve và service theo [Troubleshooting](#12-troubleshooting).

**Serve không phải Funnel:** Serve cấp HTTPS chỉ trong tailnet. Funnel có thể công khai dịch vụ ra Internet; tuyệt đối không bật cho CAW. Không proxy cổng relay 8792 qua Serve. Xem [hướng dẫn truy cập iPhone](operations/iphone-access.md).
**Giới hạn xác minh:** truy cập từ iPhone vật lý chưa được kiểm tra trong môi trường này; tài liệu vận hành đã xác nhận URL từ laptop qua tailnet. Hành vi Safari/PWA khi ngủ, bàn phím và reconnect cần kiểm tra trên thiết bị thật.


Nếu quên mật khẩu, làm theo [hướng dẫn khôi phục](operations/recovery.md#i-lost-my-password). Thao tác khôi phục cần dừng server và xóa credential; không làm khi còn người dùng app hoặc khi không chắc service thuộc quyền quản lý của bạn.

## 3. Projects

Project là thư mục laptop được đăng ký trong CAW. Conversations mới chạy trong thư mục đó; các native session OMP được nhóm theo thư mục làm việc. Project không sao chép thư mục sang iPhone.

Thêm project: **Projects** → **New Project** → duyệt tới thư mục → chọn → nhập nhãn → **Create**. Folder Browser chỉ hiển thị các thư mục trong `allowedRoots`; có thể tạo thư mục con từ giao diện nếu cần. Nhãn project chỉ là tên hiển thị. Xóa project chỉ xóa metadata, không xóa thư mục hay tệp; việc xóa project có thể bị từ chối nếu còn conversation chưa được xác nhận đã dừng.

Trên máy này, `caw.config.json` đặt `allowedRoots` là `/home/heheboiz/data`. Do đó thư mục nằm ngoài cây này không xuất hiện và không thể được duyệt qua CAW. Đường dẫn được chuẩn hóa trước khi kiểm tra; không coi allowlist này là sandbox cho agent: tiến trình OMP chạy dưới tài khoản của bạn và có thể truy cập những gì tài khoản đó cho phép.

Xem [cấu hình Ubuntu](operations/ubuntu-setup.md#3-configure) để biết ý nghĩa của `allowedRoots`.

## 4. Conversations

Conversation là bản ghi CAW gắn với project và có thể gắn với native OMP session. Mở project rồi nhấn **New chat** để tạo conversation mới. Gõ prompt vào ô chat và chọn **Send**. OMP chạy trên laptop; phản hồi sẽ xuất hiện trong giao diện khi dữ liệu được nhận.

Trong phần **Conversation model settings**, chọn model từ danh sách OMP hoặc nhập model ID tùy chỉnh. **Save model** lưu lựa chọn cho lần khởi chạy sau, không đổi model của tiến trình đang chạy. **Save & restart agent** yêu cầu khởi chạy lại conversation với model đã chọn. Danh sách model có thể trống hoặc không khả dụng nếu OMP không cung cấp catalog.

Khi agent đang chạy, nút **Stop generating** gửi lệnh abort để kết thúc lượt đang làm việc; tiến trình OMP vẫn sống, nên có thể gửi prompt tiếp theo. Muốn kết thúc hẳn tiến trình do CAW quản lý, dùng **Stop OMP session** (có hộp xác nhận khi đang có lượt chạy, approval hoặc subagent); thao tác này giải phóng một slot agent nhưng giữ nguyên journal và conversation. Conversation đã dừng có thể dùng **Restart** để khởi chạy lại với lịch sử đã ghi. Nút mở conversation từ danh sách project chỉ mở giao diện; nó không tự khởi chạy agent. Muốn quay lại transcript đã lưu, mở conversation và dùng chế độ lịch sử khi live host không có.

Giới hạn mặc định trên máy này là tối đa **3 agent chính đang hoạt động**. Đạt giới hạn thì lần khởi chạy khác có thể bị từ chối; dừng hoặc chờ một agent thay vì tạo thêm.

## 5. History

OMP ghi session journal gốc ở `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Đây là lịch sử native của OMP, độc lập với metadata CAW trong `/home/heheboiz/.local/state/coding-agent-web`. Một journal đã lưu không chứng minh agent còn chạy.

**History** ở trang Projects mở danh sách session OMP toàn cục — chức năng này tương ứng với “All OMP Conversations”. Danh sách có thể tìm theo tiêu đề, đường dẫn hoặc session ID; nhóm theo project hoặc đường dẫn, sắp xếp hoạt động gần nhất trước. Dùng **Load more** để phân trang. Danh sách có giới hạn quét; nếu có thông báo incomplete, đó là phần đầu tìm được chứ không phải toàn bộ. Giao diện cho biết số tệp đã quét, session ngoài roots bị loại và tệp không phải journal bị bỏ qua.

Chọn **View history** để đọc transcript journal ở chế độ chỉ đọc; thao tác này không gửi prompt và không khởi chạy agent. Dùng **Load older** để đọc trang cũ. Nếu journal đang có writer hoặc không xác định được writer, việc đọc có thể bị chặn để tránh đọc snapshot đang thay đổi. Một số bản ghi quá lớn hoặc dữ liệu bị cắt có thể làm transcript hiển thị không đầy đủ; journal gốc không bị sửa bởi thao tác xem.

Mỗi dòng session có các nút theo trạng thái của nó: session **đã tracked** hiển thị **Open conversation** và mở thẳng conversation CAW đã liên kết; session **chưa tracked**, đã dừng, thư mục còn tồn tại và thư mục đã là project hiển thị **Resume**; session đang live có host và relay xác nhận hiển thị **Open live**; khi chưa đủ điều kiện, nút tương ứng bị vô hiệu kèm lý do thay vì biến mất.

`History-only` là session có journal nhưng thư mục làm việc không còn tồn tại. Có thể xem lịch sử nếu đọc được, nhưng không thể Resume vào thư mục đã mất. Native session chưa thuộc project đã đăng ký vẫn có thể hiện trong danh sách toàn cục nếu nằm trong `allowedRoots`; phải thêm thư mục đó thành project trước khi Resume.

Trên máy này đã kiểm kê 61 journal: 49 nằm trong `allowedRoots`, 12 nằm ngoài nên không được hiển thị. Số lượng có thể thay đổi theo máy và thời điểm.

## 6. Giải thích mọi trạng thái

Các nhãn dưới đây không cùng một loại trạng thái. `Tracked` là quan hệ với metadata CAW; `Running`/`Stopped` nói về runtime; `Live`/`Unknown` là kết quả quan sát writer; `External` là quyền sở hữu. Một session có thể đồng thời **Tracked và Stopped**. `Tracked` không có nghĩa là đang chạy.

| Nhãn | Ý nghĩa |
|---|---|
| **Tracked** | CAW đã có conversation liên kết với native session đó. Có thể đang chạy hoặc đã dừng. Mục native session hiển thị **Open conversation** để đi thẳng tới conversation đó; **Resume** không được đưa ra vì session đã có liên kết. |
| **Untracked** | Chưa có conversation CAW liên kết session native đó. Đây là thuộc tính liên kết, không nói session còn chạy hay không. |
| **Running** | OMP báo có lượt đang chạy trong host được xác nhận. Không đồng nghĩa với hoàn tất. |
| **Stopped** | Process do CAW quản lý đã dừng và native journal vẫn đọc được. Có thể mở conversation hoặc dùng hành động thử lại phù hợp. |
| **Saved** | Transcript đọc từ journal đã lưu, trình bày chỉ đọc. Đây là nguồn hiển thị lịch sử, không phải trạng thái process. |
| **Live** | Có writer lease được quan sát là đang tồn tại; để mở live trong web còn cần host Collab và relay được xác nhận kết nối. |
| **Unknown** | Không thể xác minh trạng thái writer/host. Không có nghĩa là stopped hay idle; CAW chặn thao tác có thể tạo writer thứ hai. |
| **External** | Host/session có thật nhưng process không được CAW khởi chạy và CAW không sở hữu vòng đời của nó. Web có thể gắn viewer nếu Collab hoạt động, nhưng không thể Restart như conversation managed. |
| **History-only** | Journal còn nhưng thư mục làm việc không còn tồn tại. Đây là khả năng phục hồi đường dẫn, không phải runtime state. |
| **Awaiting input** | Agent đang chờ câu hỏi/yêu cầu đầu vào của chủ máy, chẳng hạn approval. Không phải trạng thái đã hoàn tất. |
| **Disconnected** | Kết nối trình duyệt tới live room đã mất; không chứng minh process đã dừng. Có thể thử kết nối lại. |
| **Reconnecting** | Trình duyệt đang thử lập lại kết nối live. Đây là trạng thái kết nối, độc lập với process OMP. |

Các trạng thái runtime chính xác trong hợp đồng CAW: `starting`, `running`, `idle`, `awaiting_input`, `stopping`, `stopped`, `error`, `unknown`. `idle` chỉ có nghĩa hiện không có lượt đang chạy; OMP có thể còn việc chờ, vì thế không nên hiểu là đã hoàn tất. `error` có thể cho biết process đã mất và journal không đọc được.

Một session **tracked luôn hiển thị nút Open conversation** (ở History toàn cục và ở danh sách native session trong project) để mở đúng conversation CAW đã liên kết, nên tracked không bao giờ là ngõ cụt. Ngược lại, session **untracked** chỉ có **Resume** khi đã dừng, thư mục còn tồn tại và thư mục đó đã là project.

## 7. Phân biệt các thao tác

Bảng mô tả ý nghĩa và tác động theo hành vi UI/API. “Slot” là một trong tối đa ba agent chính hoạt động; việc chỉ đọc hoặc mở viewer không tạo slot mới.

| Thao tác | Làm gì | Tạo process OMP mới? | Dùng slot mới? | Sửa native history? | Có thể tạo fork? | An toàn khi nào; sau đó |
|---|---|---:|---:|---|---|---|
| **View history** | Đọc transcript journal trong giao diện chỉ đọc. | Không | Không | Không; chỉ đọc. | Không | Dùng để xem lịch sử. Có thể bị chặn khi writer đang chạy hoặc không xác minh được. |
| **Resume** | Tạo conversation CAW gắn với native session cũ và khởi chạy OMP dựa trên journal đó. Sau đó session được Tracked; prompt bị ngắt không tự phát lại. | Có, nếu được chấp nhận | Có | Có; OMP có thể ghi tiếp cùng journal | Không chủ ý | Chỉ khi writer đã xác nhận không hoạt động, thư mục còn tồn tại và đã đăng ký project. Nếu lease unknown/live, thao tác bị chặn. |
| **Open conversation** | Bấm nút **Open conversation** trên mục session đã tracked (ở History toàn cục hoặc danh sách native session trong project) để mở đúng conversation CAW đã liên kết; nếu có Collab host, giao diện có thể kết nối room. | Không | Không thêm slot | Không bởi thao tác mở | Không | Dùng để trở lại conversation đã tracked; không phải Resume, và không cần rời trang để tìm lại conversation. |
| **Open live** | Gắn CAW conversation external vào native session đang chạy có host và relay kết nối; mở viewer. | Không | Không tạo agent process/slot mới | Không bởi thao tác gắn | Không | Khi writer và Collab host/relay đều được xác nhận. External process vẫn do người khởi chạy quản lý. |
| **Attach from terminal** | Kết nối terminal laptop vào tmux session managed đã có qua private socket. | Không | Không | Không bởi attach; OMP tiếp tục có thể ghi journal như thường | Không | Dùng lệnh CAW đưa ra cho đúng conversation. Thoát attach bằng `Ctrl-b`, rồi `d`; không gửi lệnh dừng. |
| **Stop generating** | Gửi lệnh abort qua Collab để kết thúc **lượt đang chạy**. | Không | Không | Việc đã xảy ra có thể đã được OMP ghi vào journal; không xoá lịch sử | Không | Dùng khi chỉ muốn dừng lượt hiện tại; **tiến trình OMP vẫn sống** và có thể nhận prompt tiếp theo. |
| **Stop OMP session** | Gọi hành động dừng của server để kết thúc **tiến trình OMP do CAW quản lý** và giải phóng slot agent. | Không (kết thúc process, không tạo mới) | Có — giải phóng một slot trong tối đa 3 | Journal và conversation được giữ nguyên, không xoá | Không | Chỉ với session managed. Có hộp xác nhận khi đang có lượt chạy, approval hoặc subagent. Sau khi dừng, conversation vẫn xem được và **Restart** được theo các guard an toàn hiện có. |
| **Handoff (`/handoff`)** | Gửi lệnh gốc `/handoff` của OMP vào pane managed để nén ngữ cảnh tại chỗ. | Không | Không | Có — OMP ghi một compaction entry; journal cũ và session id giữ nguyên | Không | Chỉ với session managed, writer đã xác minh idle, không có terminal attach, không đang stream/handoff khác. Tốn token AI. Chi tiết ở [chương 10](#10-lệnh-handoff--nén-ngữ-cảnh-tại-chỗ). |
| **Restart** | Với conversation managed, dừng/khởi chạy lại và tiếp tục native session liên kết khi có. | Có (khởi chạy lại) | Có | Tiếp tục ghi lịch sử native đang gắn | Không chủ ý | Chỉ khi sở hữu conversation và chấp nhận gián đoạn. External hoặc identity không xác minh được sẽ bị từ chối. |
| **Create new conversation** | Tạo conversation mới trong project. | Có | Có | Tạo native session mới khi OMP khởi chạy | Không | Dùng cho công việc mới, không phải cách mở lịch sử cũ. |
| **Fork (khi được hỗ trợ)** | Fork sẽ tạo nhánh session theo khả năng của OMP. | Chưa xác minh trong UI hiện tại | Chưa xác minh | Có thể tạo journal/nhánh riêng tùy OMP | Có theo ý nghĩa fork, nhưng không được CAW hứa hẹn | Không thấy thao tác Fork trong giao diện CAW đã đọc; dùng khả năng OMP trực tiếp chỉ khi đã hiểu tác động. |

Không thử Resume nhiều lần để “mở lại” conversation; session đã tracked có nút **Open conversation** để mở thẳng conversation đã liên kết. Khi writer live hoặc unknown, dừng lại và tìm host hiện có thay vì tạo writer mới.

**Hai hành động dừng khác nhau, đừng nhầm:** **Stop generating** chỉ kết thúc lượt đang chạy và để tiến trình OMP sống; **Stop OMP session** kết thúc tiến trình OMP do CAW quản lý và giải phóng slot. Không hành động nào xoá lịch sử. Cả hai chỉ áp dụng cho session **do CAW quản lý**; session external không dừng được từ CAW, phải dừng tại terminal của nó.

## 8. Sử dụng cùng một conversation trên Ubuntu và iPhone

### Bắt đầu trên Ubuntu, tiếp tục trên iPhone

1. Mở CAW trên Ubuntu hoặc iPhone và đăng nhập.
2. Vào project rồi **New chat**, gửi prompt. Agent chạy trên laptop trong tmux riêng.
3. Mở cùng project/conversation trên iPhone. CAW mở liên kết Collab tới host hiện có, không cần chạy agent lần thứ hai.
4. Nếu Safari ngủ hoặc mất mạng, giao diện có thể báo Disconnected/Reconnecting. Khi kết nối lại, CAW đồng bộ lại từ host; trạng thái mất kết nối không dừng OMP.

### Bắt đầu trên iPhone, attach từ Ubuntu

1. Tạo conversation và gửi prompt từ iPhone.
2. Mở cùng conversation trên laptop. Trong phần hướng dẫn attach, CAW hiển thị lệnh chính xác cho session đó.
3. Dạng lệnh trên máy này:

```bash
tmux -S /home/heheboiz/.local/state/coding-agent-web/tmux.sock attach -t '<session_id>'
```

Thay `<session_id>` bằng ID mà CAW đưa ra; không đoán tên tmux. Để thoát terminal mà không dừng OMP, nhấn `Ctrl-b`, rồi `d` (detach). Đóng terminal sau khi detach.

### Đóng Safari mà không dừng OMP

Đóng tab hoặc để iPhone ngủ chỉ ngắt viewer. OMP tiếp tục chạy trong tmux và có thể tiếp tục dùng tài nguyên hoặc thực hiện công cụ. Đóng trình duyệt không phải lệnh dừng nào cả; muốn kết thúc lượt đang chạy, dùng **Stop generating**; muốn kết thúc tiến trình do CAW quản lý, dùng **Stop OMP session**.

### Resume native session cũ

1. Mở **History**, tìm session và kiểm tra trạng thái writer.
2. Nếu `live` là false, thư mục còn tồn tại và project đã đăng ký, chọn **Resume**.
3. CAW tạo conversation liên kết session native; từ thời điểm đó mục sẽ là **Tracked**, và mục đó hiển thị nút **Open conversation** để mở thẳng conversation vừa tạo — cả ở History toàn cục lẫn ở danh sách native session trong project. Tracked không khẳng định agent đang chạy.

### Khi đã có writer hoạt động

Không Resume hoặc Restart thêm lần nữa. Nếu session live có host/relay, dùng **Open live** hoặc mở conversation CAW đã quản lý. Nếu đó là OMP chạy thủ công trong terminal và không có Collab host, điều khiển qua terminal hiện có; CAW không thể tự tạo viewer Collab cho host không được xác nhận.

OMP bảo vệ session native bằng writer lease. CAW kiểm tra lease trước khi tạo writer; lease đang giữ hoặc không xác minh được thì từ chối. Mở một writer thứ hai có thể làm rẽ nhánh/làm hỏng lịch sử. Cần phân biệt **vòng đời kết nối trình duyệt** (có thể ngắt, nối lại) với **vòng đời process OMP** (sống trong tmux, không phụ thuộc tab).

### Sau khi service restart hoặc laptop reboot

Service backend có thể khởi động lại trong khi agent managed còn sống; khi lên lại, CAW đối chiếu tmux, Collab registry và journal để nhận diện. Nếu không đủ bằng chứng, trạng thái là unknown chứ không đoán đã dừng. Sau khi laptop reboot, các process thường đã mất nhưng journal vẫn còn; dùng History để xem và Resume có chủ ý. Prompt bị ngắt không tự phát lại. Xem [phục hồi](operations/recovery.md) và [triển khai service](operations/deployment.md).

## 9. Công cụ và giao diện chat

Giao diện hiển thị tin nhắn người dùng/trợ lý, nội dung streaming khi nhận được, hàng kết quả tool có thể mở/đóng, trạng thái tool đang chạy hoặc lỗi, và sự kiện hoạt động trong **Activity**. Transcript tool dùng dữ liệu OMP/Collab mà client nhận; CAW không đọc terminal để tự dựng lại mọi output.

Khi OMP cần phản hồi UI, CAW hiển thị yêu cầu/approval cùng các lựa chọn hoặc ô nhập. Người dùng có thể gửi phản hồi hoặc hủy; link read-only không thể trả lời, gửi prompt, **Stop generating** hay **Stop OMP session**. Không tự động phê duyệt khi điện thoại mất kết nối. Panel **Agents** cho phép xem agent con và transcript được yêu cầu theo từng phần.

Giao diện có ô prompt, gợi ý một số slash command, trạng thái kết nối, nút **Latest** khi đã cuộn khỏi cuối transcript, lựa chọn model và transcript lịch sử đọc-only. Khu vực hành động của conversation gồm **Stop generating**, **Handoff context** và **Stop OMP session** (mỗi nút có thể bị vô hiệu kèm lý do khi không dùng được). Khi gõ một lệnh gốc của OMP như `/handoff`, CAW không gửi nó như prompt mà hiển thị hộp xác nhận; xem [chương 10](#10-lệnh-handoff--nén-ngữ-cảnh-tại-chỗ). Khi gửi prompt chưa được xác nhận, CAW có thể báo chưa rõ host đã nhận hay chưa; đừng gửi lại một cách mù quáng vì prompt có thể đã chạy.

**Giới hạn khác:** nếu mục tracked không hiển thị **Open conversation**, giao diện ghi “Tracked conversation ID is unavailable” (nút chỉ xuất hiện khi session có conversation ID). Khi đó dùng **Projects** để mở project và chọn conversation.

**Hạn chế:** không thấy chức năng đính kèm tệp từ giao diện chat; chia sẻ đường dẫn trong prompt không phải upload tệp. Không thấy trình xem diff chuyên biệt; nếu agent trả diff dưới dạng văn bản thì nó chỉ hiện như nội dung transcript. Không hứa rằng mọi tool output, nội dung lịch sử cũ, trạng thái con hoặc sự kiện đều có mặt: OMP/Collab có thể không gửi, trang transcript có thể bị giới hạn hoặc một bản ghi quá lớn bị bỏ qua khi hiển thị. Chi tiết giao diện này có thể mở rộng khi các phần đang được cải thiện.

## 10. Lệnh `/handoff` — nén ngữ cảnh tại chỗ

`/handoff` là **lệnh gốc (builtin) của OMP**, không phải prompt gửi cho model. Nó được OMP xử lý trong terminal của session và ghi thêm một **compaction entry tại chỗ** vào cùng session đó.

### `/handoff` khác `/compact` thế nào

Cả hai đều ghi một **compaction entry tại chỗ trên cùng một session** (không tạo session mới, không tạo process mới, không xoá lịch sử). Khác nhau ở nguồn văn bản dùng làm phần tóm tắt:

| Lệnh | Phần tóm tắt lấy từ đâu | Ai chạy được từ CAW |
|---|---|---|
| `/handoff` | Văn bản bàn giao (handoff document) do OMP tạo và dùng làm phần tóm tắt ngữ cảnh | Có — nút **Handoff context** hoặc gõ `/handoff` trong ô chat |
| `/compact` | Bản tóm tắt thông thường | Không — CAW không có điều khiển Collab cho `/compact`; chạy trong terminal OMP |

### Có tạo session mới không? Có mất lịch sử không? Có tốn token không?

- **Không tạo session mới.** Session id, tệp journal và conversation giữ nguyên; chỉ phần ngữ cảnh cũ được nén lại.
- **Không mất lịch sử cũ.** Journal không bị xoá; các entry cũ vẫn còn trên đĩa và vẫn đọc được.
- **Có tốn token AI.** OMP phải gọi model để tạo bản tóm tắt/handoff document, nên thao tác này tiêu thụ token.

### Cách dùng trên iPhone

1. Mở conversation trong CAW (bắt buộc là conversation do CAW quản lý, xem điều kiện bên dưới).
2. Chọn một trong hai cách:
   - gõ `/handoff` trong ô chat. Chuỗi này **không** được gửi như prompt cho model: CAW nhận ra đây là lệnh gốc, hiển thị hộp xác nhận rồi yêu cầu server gõ lệnh vào terminal managed của session;
   - hoặc bấm nút **Handoff context** trong khu vực hành động của conversation, rồi bấm **Run handoff**.
3. Xác nhận. Khi thành công, banner sẽ báo “Handoff committed — context compacted in place; session unchanged.”

**Truyền focus instructions — hiện chưa hỗ trợ.** CAW chỉ gửi đúng chuỗi `/handoff`. Mọi tham số kèm theo (ví dụ nội dung focus) bị từ chối với mã `capability_missing` và thông báo “Only the bare /handoff command is supported; focus instructions are not.” Đây là **giới hạn có chủ đích vì lý do an toàn**: `/handoff` được gõ vào terminal bằng bracketed paste, và CAW không cho phép bất kỳ văn bản tuỳ ý nào từ request đi vào pane. Nếu bạn cần focus cụ thể, hãy attach vào terminal của session và chạy `/handoff` tại đó.

### Điều kiện bắt buộc (và vì sao)

`/handoff` là một **keystroke vào TUI đang chạy**, nên server kiểm tra mọi điều kiện trước khi gõ. Không thoả một điều kiện nào thì thao tác bị từ chối thay vì đoán:

| Điều kiện | Vì sao |
|---|---|
| Session **do CAW quản lý** (`ownership === "managed"`) | Chỉ process của CAW mới có tmux session id, server identity và pane PID để chứng minh đúng process. Session external luôn bị từ chối; hãy chạy `/handoff` tại terminal của nó. |
| Writer đang **idle đã xác minh** | Gõ vào session đang chạy lượt là tạo writer thứ hai bằng keystroke. OMP phải báo host control đã kết nối, `busy === false` và `inputRequired === false`; giá trị thiếu hoặc không rõ bị coi là từ chối. |
| **Không có terminal nào đang attach** | Nếu có terminal attach, keystroke sẽ rơi vào draft của người dùng chứ không vào input của agent. |
| **Không đang stream** (điều kiện idle ở trên) và không có handoff khác đang chạy | Gõ vào session đang sinh nội dung là chồng writer. Server đã kiểm tra cùng điều kiện idle (`busy === false`) cho luồng đang chạy; một handoff đang xử lý cho cùng conversation bị chặn riêng bằng `handoff_in_flight`. |
| Pane đúng là process đã ghi nhận | CAW đối chiếu tmux server identity, pane id và pane PID; lệch một mục nào là dừng. |

### Khi `/handoff` thất bại

| Mã lỗi | Nghĩa | Việc cần làm |
|---|---|---|
| `terminal_attached` | Có terminal đang attach vào session này, nên keystroke sẽ không tới input của agent. | Detach terminal đó (`Ctrl-b` rồi `d`) rồi thử lại, hoặc chạy `/handoff` ngay tại terminal đang attach. |
| `handoff_in_flight` | Đã có một handoff đang chạy cho conversation này. | Chờ handoff hiện tại kết thúc rồi thử lại. |
| `conflict_owner` | Không chứng minh được process cần gõ vào: session external, không có tmux session/pane đã ghi nhận, identity server đã đổi, hoặc session không idle. | Đọc thông báo cụ thể, làm mới conversation; nếu là session external hoặc terminal thủ công, chạy `/handoff` tại terminal đó thay vì trong CAW. |
| `capability_missing` | Server chưa cấu hình handoff, hoặc request kèm tham số focus. | Gửi đúng lệnh `/handoff` không tham số; nếu server thiếu cấu hình, xem log service và [triển khai](operations/deployment.md). |

Không thao tác nào ở trên xoá lịch sử; journal chỉ thay đổi khi OMP ghi compaction entry của chính nó.

## 11. Giới hạn và bảo mật

- Tối đa ba agent chính hoạt động cùng lúc theo cấu hình hiện tại; đây không phải cam kết về số agent con. Agent con do OMP quản lý và có thể tiêu thụ tài nguyên; UI có panel theo dõi nhưng mức giới hạn con không được xác minh ở đây. **Stop OMP session** giải phóng một slot; **Stop generating** thì không.
- Mỗi native session chỉ nên có một writer. Không Resume session đang có writer; writer lease `unknown` cũng chặn Resume/đọc lịch sử ở một số đường đi vì không thể chứng minh an toàn. `/handoff` cũng bị từ chối khi không xác minh được writer đang idle hoặc khi có terminal đang attach — để tránh biến keystroke thành writer thứ hai.
- `allowedRoots` giới hạn duyệt project và journal trong CAW, không phải sandbox hệ điều hành. Agent chạy với quyền tài khoản laptop, có thể truy cập dữ liệu mà tài khoản đó được phép.
- App chỉ được đưa lên tailnet bằng Tailscale Serve, sau lớp đăng nhập CAW. Kết nối tailnet không thay thế mật khẩu ứng dụng. Dùng HTTPS, giữ iPhone và tài khoản Tailscale an toàn.
- Link Collab là bearer credential: người có link control có thể đọc/điều khiển room live. Không gửi link, token setup, mật khẩu, bí mật phòng Collab hoặc nội dung journal riêng tư vào GitHub, issue, log, ảnh chụp hay thông báo. Không lưu link Collab vào nơi chia sẻ công khai.
- Không công khai cổng 8791 ra Internet, không bật Funnel và không proxy cổng 8792. Không chạy service bằng root. Agent không được sandbox khỏi quyền của người dùng; hãy đọc kỹ yêu cầu tool/approval.

Đọc [mô hình bảo mật](architecture/security-model.md), [thiết lập Ubuntu](operations/ubuntu-setup.md) và [triển khai](operations/deployment.md) trước khi đổi cấu hình mạng.

## 12. Troubleshooting

Các lệnh dưới đây chỉ kiểm tra/truy vấn, ngoại trừ `restart` được ghi rõ. Chạy các lệnh trên laptop với tài khoản sở hữu service. **Khi một lệnh khởi chạy Node hoặc tiến trình con, đặt `TMPDIR=$HOME/.cache`** để tránh lỗi quota ở `/tmp`; ví dụ `TMPDIR=$HOME/.cache node ...`. Các lệnh chẩn đoán bên dưới không khởi chạy OMP agent.

| Vấn đề | Kiểm tra hoặc hành động |
|---|---|
| Web không vào được | `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8791/api/auth/me` — `401` là phản hồi mong đợi khi chưa đăng nhập. `000`/lỗi kết nối thường có nghĩa server không nghe. Sau đó xem `systemctl --user status coding-agent-web` và `tailscale serve status`. |
| Tailscale mất kết nối | `tailscale status` — xác nhận laptop đăng nhập/online; xác nhận iPhone cùng tailnet và online. |
| Service systemd dừng | `systemctl --user status coding-agent-web`; xem log. Chỉ nếu bạn sở hữu service và chấp nhận gián đoạn, chạy `systemctl --user restart coding-agent-web`. Restart backend không được dùng như cách dừng agent. |
| Xem log service | `journalctl --user -u coding-agent-web -n 100 --no-pager`. |
| Đăng nhập thất bại | Kiểm tra password/token đúng, token chưa quá 15 phút/chưa dùng, và giờ hệ thống. Đợi nếu có backoff sau nhiều lần sai. Không gửi credential qua chat/log. |
| Quên mật khẩu | Làm theo [khôi phục chính thức](operations/recovery.md#i-lost-my-password). Cần dừng service, xóa credential record rồi khởi động lại để tạo setup token mới; không thực hiện khi chưa chắc quyền sở hữu service. Agent/journal không bị xóa bởi thao tác đó. |
| Session không hiện | Kiểm tra thư mục làm việc có trong `allowedRoots` và đã thêm thành project nếu muốn Resume. Global History chỉ liệt kê native journal đọc được trong roots; journal ngoài roots bị loại. |
| Tracked session không Resume được | Hành vi có chủ ý: session đã có conversation liên kết nên không tạo liên kết thứ hai. Bấm **Open conversation** ngay trên mục đó (có ở cả History toàn cục và danh sách native session trong project) để mở conversation. Nếu stopped, dùng Retry/Restart phù hợp từ conversation managed. |
| Session live không có Collab | Xem `tmux -S /home/heheboiz/.local/state/coding-agent-web/tmux.sock ls` và `omp collab list`. Nếu agent do terminal khởi chạy nhưng không có host Collab, CAW không thể mở live viewer; không khởi chạy writer khác. |
| WebSocket reconnect | Kiểm tra `tailscale status`, `tailscale serve status` và trạng thái service. Có thể bấm Retry trong giao diện. Disconnected/Reconnecting chỉ nói về kết nối viewer; không chứng minh agent đã dừng. |
| Sai thư mục project | Đối chiếu đường dẫn hiển thị và `allowedRoots` trong `caw.config.json`. Chọn đúng thư mục khi thêm project; không sửa journal để đổi project. |
| Writer lease không xác định | Trạng thái `unknown` không đồng nghĩa với lease rảnh. Không Resume hoặc tạo writer mới. Kiểm tra service, tmux socket và OMP registry; xem [phục hồi](operations/recovery.md). |
| OMP/tmux thiếu hoặc không chạy | `command -v omp tmux`; `omp --version`; `tmux -V`. Service systemd có PATH riêng; xem log service và [triển khai](operations/deployment.md#troubleshooting). |
| Danh sách model trống | Kiểm tra `omp models` trong terminal. UI hỗ trợ model ID tùy chỉnh; catalog rỗng/không sẵn sàng không làm mất lựa chọn đã lưu. |
| Attach terminal lỗi | Dùng nguyên lệnh CAW hiển thị, gồm socket riêng và ID `$N`; kiểm tra `tmux -S /home/heheboiz/.local/state/coding-agent-web/tmux.sock ls`. Không dùng tmux socket mặc định của cá nhân. |
| `/handoff` báo `terminal_attached` | Có terminal đang attach vào session đó. Detach (`Ctrl-b` rồi `d`) rồi thử lại, hoặc chạy `/handoff` tại terminal đang attach. |
| `/handoff` báo `conflict_owner` | Không chứng minh được process/pane cần gõ vào, hoặc session không idle (có thể đang chạy lượt). Làm mới conversation và chỉ thử lại khi session idle; session external phải chạy `/handoff` tại terminal của nó. |
| `/handoff` báo `capability_missing` | Request có kèm tham số focus, hoặc server chưa cấu hình handoff. Gửi đúng chuỗi `/handoff` không tham số; nếu vẫn lỗi, xem log service. |
| `Stop generating` không kết thúc lượt | Có thể lệnh abort chưa gửi được (mất kết nối). Giao diện báo lỗi gửi; kiểm tra kết nối rồi thử lại. Process vẫn sống nên agent có thể vẫn đang chạy. |
| `Stop OMP session` không dùng được | Chỉ áp dụng cho session **managed** có tmux session/identity đã ghi nhận. Session external hoặc thiếu identity sẽ bị vô hiệu kèm lý do; dừng tại terminal của session đó nếu cần. |
| Sau reboot | Kiểm tra `systemctl --user status coding-agent-web`, `journalctl --user -u coding-agent-web -n 100 --no-pager`, và private tmux socket. Agent process có thể đã mất nhưng journal còn; CAW không tự phát lại prompt. Xem [phục hồi](operations/recovery.md#the-laptop-rebooted). |

Các chẩn đoán hữu ích:

```bash
systemctl --user status coding-agent-web
journalctl --user -u coding-agent-web -n 100 --no-pager
tailscale serve status
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8791/api/auth/me
tmux -S /home/heheboiz/.local/state/coding-agent-web/tmux.sock ls
omp --version
```

`curl` tới `/api/auth/me` trả `401` nếu chưa đăng nhập là dấu hiệu API đang phản hồi, không phải lỗi service. Xem thêm [truy cập iPhone](operations/iphone-access.md), [khôi phục](operations/recovery.md), [triển khai](operations/deployment.md) và [các vấn đề môi trường](operations/environment-quirks.md).

## 13. FAQ

### Vì sao Resume xong lại thành Tracked?

Resume tạo conversation CAW liên kết với native session cũ. `Tracked` ghi nhận liên kết này để không tạo conversation thứ hai cho cùng session; nó không mô tả process đang chạy hay đã dừng.

### Tracked có nghĩa là agent vẫn chạy không?

Không. `Tracked` chỉ nói CAW biết conversation tương ứng. Kiểm tra runtime hoặc writer badge riêng; session có thể Tracked và Stopped.

### Làm sao mở lại conversation đã tracked?

Trong **History** (danh sách toàn cục) hoặc trong danh sách native session của project, session **đã tracked** hiển thị nút **Open conversation**: bấm vào đó để đi thẳng tới đúng conversation CAW — không cần quay lại trang nào. Với session đã tracked, nút **Resume** không được đưa ra vì session đã có conversation liên kết; Resume sẽ tạo liên kết thứ hai cho cùng session, đúng thứ CAW tránh. Chỉ session **chưa tracked**, đã dừng (`live` là false), thư mục còn tồn tại và thư mục đã là project mới có **Resume**. Nếu nút **Open conversation** không thấy, giao diện ghi rõ “Tracked conversation ID is unavailable”; kiểm tra đúng project và session ID.

### Đóng Safari có làm OMP dừng không?

Không. Safari chỉ là viewer. Process OMP chạy trong tmux trên laptop. Nếu muốn dừng agent, **Stop generating** kết thúc lượt đang chạy (process vẫn sống); **Stop OMP session** kết thúc hẳn tiến trình do CAW quản lý và giải phóng slot.

### Xem History có tốn token AI không?

View history đọc journal đã lưu và không gửi prompt hay tạo OMP process; vì vậy thao tác xem không gọi agent để sinh câu trả lời. Các agent đang chạy độc lập vẫn có thể tiếp tục công việc và sử dụng tài nguyên/chi phí của chúng.

### Tại sao có 61 session nhưng chỉ thấy 49?

Trên máy này 61 journal đã được kiểm kê; 12 nằm ngoài `allowedRoots` (`/home/heheboiz/data`) nên CAW loại khỏi danh sách. Các số này là ảnh chụp tại thời điểm kiểm kê, không phải giới hạn sản phẩm.

### Tôi có thể mở cùng một session ở Ubuntu và iPhone không?

Có thể xem cùng session qua CAW và attach terminal vào tmux hiện có. Không được khởi chạy thêm writer cho cùng native session. Từ terminal dùng lệnh attach CAW hiển thị; từ iPhone dùng conversation live đã có.

### Tại sao View History đôi khi không sử dụng được?

CAW có thể từ chối đọc khi session đang live hoặc writer lease không xác minh được, tránh xem snapshot đang được ghi hoặc đoán session đã dừng. Kiểm tra writer/Collab và thử lại sau khi trạng thái rõ ràng.

### Tại sao web không hiện tất cả tool output?

Giao diện chỉ hiện dữ liệu transcript và sự kiện OMP/Collab nhận được. Journal/trang có thể bị phân trang; một bản ghi lớn có thể bị bỏ qua khi hiển thị; output không được chuyển thành transcript có cấu trúc sẽ không tự xuất hiện. Dùng History, Load older, Activity hoặc terminal attach để kiểm tra thêm; không coi transcript web là bản ghi đầy đủ mọi thứ OMP đã làm.

### Mất mạng thì agent có dừng không?

Không nhất thiết. Mất WebSocket làm viewer thành Disconnected/Reconnecting; process OMP có thể vẫn chạy. Kiểm tra trạng thái agent riêng trước khi gửi lại prompt.

### CAW có thể đọc session ở thư mục bất kỳ không?

Không qua danh sách CAW: journal phải thuộc `allowedRoots`. Trên máy này chỉ cho phép `/home/heheboiz/data`. Đây là giới hạn duyệt của app, không phải sandbox của tiến trình agent.

### `/handoff` có tạo session mới không? Có mất lịch sử không?

Không tạo session mới: nó nén ngữ cảnh **tại chỗ**, cùng session id và cùng tệp journal. Lịch sử cũ không bị xoá — OMP chỉ ghi thêm một compaction entry; các entry cũ vẫn còn trên đĩa.

### Vì sao không gửi được focus instructions kèm `/handoff`?

Đây là giới hạn có chủ đích vì an toàn: CAW chỉ gõ đúng chuỗi `/handoff` cố định vào terminal managed, không cho văn bản tuỳ ý từ request đi vào pane. Request kèm tham số focus bị từ chối với `capability_missing`. Nếu cần focus cụ thể, attach terminal và chạy `/handoff` tại đó.

### `/handoff` báo `terminal_attached` — làm sao?

Có terminal đang attach vào session, nên keystroke sẽ rơi vào draft của bạn chứ không tới agent. Detach bằng `Ctrl-b` rồi `d` và thử lại, hoặc chạy `/handoff` ngay tại terminal đang attach.

### Luôn gửi được `/handoff` cho mọi conversation phải không?

Không. Chỉ session **do CAW quản lý** mới dùng được: writer phải đang idle đã xác minh, không có terminal nào attach, không đang stream và không có handoff/compaction khác đang chạy. Session external luôn bị từ chối (`conflict_owner`); hãy chạy `/handoff` tại terminal của nó.
