# Spec: ส่งรูปภาพและไฟล์ในแชท (Chat media attachments)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to turn this spec into a task-by-task implementation plan before touching code.

**เป้าหมาย:** ให้คู่สนทนาส่งรูปภาพและไฟล์ทั่วไปหากันในแชทได้ นอกเหนือจากข้อความตัวหนังสือ

**ขอบเขต (สโคปนี้เท่านั้น):** รูปภาพ + ไฟล์ทั่วไป (เอกสาร/บีบอัด/ฯลฯ) เท่านั้น — **ไม่รวม** วิดีโอ, เสียง (voice message), และสติ๊กเกอร์/emoji แบบไฟล์ (emoji แบบ Unicode ในข้อความมีอยู่แล้วจาก PR ก่อนหน้า) สามอย่างหลังเป็นงานแยกที่มีการตัดสินใจเรื่อง storage/UX ของตัวเองและจะออกแบบทีหลัง

## Global Constraints

- **โค้ด คอมเมนต์ในโค้ด ชื่อตัวแปร และ commit message ทั้งหมดเป็นภาษาอังกฤษ** — เอกสารนี้เป็นไทยเพื่อให้เจ้าของโปรเจกต์อ่านได้เท่านั้น
- ไฟล์แนบจำกัดขนาด: รูปภาพ ≤ 10MB, ไฟล์อื่น ≤ 25MB
- อนุญาตทุกชนิดไฟล์ **ยกเว้น** ไฟล์คำสั่ง/โปรแกรม — บล็อกด้วย extension และ MIME type ที่รู้จักกันว่าเป็น executable: `.exe .bat .cmd .sh .msi .app .apk .dll .com .scr .ps1 .vbs .jar` (รายการนี้เป็น denylist ที่แก้ในที่เดียวคือ `src/lib/attachments.js`)
- ห้ามให้ไฟล์แนบเข้าถึงได้จากคนนอกบทสนทนา — presigned GET URL ต้องออกให้เฉพาะตอนที่ผู้เรียก API เป็นหนึ่งในสองผู้ร่วมสนทนาเท่านั้น (ตรวจซ้ำทุกครั้งที่ mint URL ใหม่ ไม่ใช่แค่ตอนสร้างข้อความ) และ URL ต้องหมดอายุสั้น (5 นาทีพอสำหรับโหลดหน้าเว็บ)
- ไม่ backup ไฟล์แนบขึ้น Google Drive ในรอบนี้ (ดูหัวข้อ "Drive backup" ด้านล่าง)

## สถาปัตยกรรม

**ที่เก็บไฟล์:** Cloudflare R2 (S3-compatible API) ผ่าน `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (ต้องเพิ่ม dependency ใหม่ 2 ตัวที่ root `package.json` — ไม่มี dependency สำหรับ object storage ในแอปนี้มาก่อนเลย)

**ทำไมไม่ proxy ไฟล์ผ่านเซิร์ฟเวอร์เราเอง:** `render.yaml` บอกไว้ชัดว่าแอปนี้รันเป็น single instance บน free plan ถ้าให้ไฟล์รูป/เอกสารไหลผ่าน Express process เดียวกันกับที่ถือ SSE connection ของทุกคนไว้ (`src/lib/chatBus.js`) การอัปโหลด/ดาวน์โหลดไฟล์ใหญ่พร้อมกันหลายคนจะแย่ง CPU/memory จนกระทบการส่งข้อความสด — จึงต้องให้ไบต์ของไฟล์วิ่งตรงระหว่างเบราว์เซอร์กับ R2 ไม่ผ่านเซิร์ฟเวอร์เราเลย เซิร์ฟเวอร์ทำหน้าที่แค่ออก presigned URL (ข้อความสั้นๆ) และตรวจสอบสิทธิ์

**Upload flow (3 ขั้นตอน):**

1. `POST /api/chat/uploads` — ไคลเอนต์ส่ง `{ conversationId, fileName, mimeType, size }` เซิร์ฟเวอร์ตรวจว่าผู้เรียกเป็นผู้ร่วมสนทนาจริง (ใช้ `getConversationForParticipant` เดิม) และเป็นเพื่อนกับอีกฝ่ายอยู่ (ใช้ `areFriends` เดิม เหมือน route ส่งข้อความ) ตรวจ `size`/`mimeType`/extension ตามข้อจำกัดด้านบน แล้วสร้าง key แบบ `conversations/<conversationId>/<uuid>-<sanitizedFileName>` คืน presigned **PUT** URL (หมดอายุ 5 นาที) + key นั้นกลับไป
2. ไคลเอนต์ `PUT` ไฟล์ตรงไปที่ URL นั้น (ไม่ผ่าน `/api`)
3. `POST /api/chat/conversations/:id/messages` — เพิ่ม field ที่รับได้ใหม่ `attachmentKey` (optional, คู่กับ `body` ที่ตอนนี้ optional ได้เหมือนกันถ้ามี attachment) เซิร์ฟเวอร์ยิง `HeadObject` ไปที่ R2 เพื่อ**ยืนยันของจริง**ว่าไฟล์มีอยู่และขนาด/ชนิดตรงตามที่อนุญาต (ไม่เชื่อค่าที่ไคลเอนต์อ้างตอนขอ presigned URL เพราะไคลเอนต์อาจอัปโหลดไฟล์อื่นทับ key เดิมก็ได้) ผ่านแล้วค่อยสร้างแถว `Message`

**Download flow:** `GET /conversations/:id/messages` (route เดิม) แนบ presigned **GET** URL (หมดอายุ 5 นาที) ไปกับทุกข้อความที่มี `attachmentKey` แทนที่จะคืน URL ถาวร — ทุกครั้งที่โหลดหน้าแชทจะ mint URL ใหม่ ตรงกับหลักที่แอปนี้ยึดอยู่แล้วว่าคนนอกบทสนทนาต้องเข้าไม่ได้ (404 ไม่ใช่ 403)

## Data Model

เพิ่มใน `Message` (`prisma/schema.prisma`), migration ใหม่:

```prisma
model Message {
  id                Int      @id @default(autoincrement())
  conversationId    Int
  senderId          Int
  /// Nullable now: a message can be attachment-only with no text.
  body              String?  @db.Text
  attachmentKey     String?
  attachmentName    String?
  attachmentMimeType String?
  attachmentSize    Int?
  /// "image" renders inline in the bubble; "file" renders as a
  /// name+size+download card. Derived server-side from mimeType at
  /// creation, not trusted from the client as a separate field.
  attachmentType    String?
  createdAt         DateTime @default(now())
  ...
}
```

- ต้องมี constraint ระดับ application (ไม่ใช่ DB): ข้อความต้องมี `body` หรือ `attachmentKey` อย่างน้อยหนึ่งอย่าง (ห้ามว่างทั้งคู่) — เช็คใน route เดียวกับที่เช็ค `body` ความยาวอยู่แล้ว
- `attachmentType` คำนวณจาก `mimeType` ฝั่งเซิร์ฟเวอร์ตอนสร้างข้อความ (`image/*` → `"image"`, อื่นๆ → `"file"`) ไม่รับค่าจากไคลเอนต์โดยตรง

## API Changes

| Endpoint | เปลี่ยนแปลง |
|---|---|
| `POST /api/chat/uploads` | **ใหม่** — ออก presigned PUT URL ตามที่อธิบายด้านบน |
| `POST /api/chat/conversations/:id/messages` | รับ `attachmentKey` เพิ่ม (optional), `body` เป็น optional ได้ถ้ามี `attachmentKey`, ยืนยันไฟล์จริงบน R2 ก่อนสร้างข้อความ |
| `GET /api/chat/conversations/:id/messages` | แนบ presigned GET URL (field ใหม่ `attachmentUrl`) ให้ทุกข้อความที่มี `attachmentKey` |
| `GET /api/chat/stream` (SSE) | payload ของ event `message` มี field ไฟล์แนบเพิ่มเหมือนกัน (รวม `attachmentUrl` ที่ mint สดตอน publish) |

`src/lib/attachments.js` (ใหม่) รวม logic ที่ใช้ร่วมกัน: client R2 (`S3Client` ชี้ endpoint ของ R2), การตรวจ extension/mime denylist, การสร้าง key, และฟังก์ชัน mint presigned PUT/GET — ให้ทั้ง `POST /uploads` และ `GET /messages` เรียกใช้ฟังก์ชันเดียวกันแทนที่จะเขียนซ้ำ

## Environment Variables ใหม่

ทั้งหมด optional-service pattern เดียวกับ Drive/Push/Google sign-in — ถ้าไม่ตั้งค่า `POST /api/chat/uploads` จะ 503 แทนที่จะพังทั้งแอป (`attachmentsConfigured` gate เหมือน `driveConfigured`):

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

## Frontend

- **Composer** (`web/src/pages/ChatPage.jsx`): เพิ่มปุ่มแนบไฟล์ข้าง emoji picker → เปิด file picker ของเบราว์เซอร์ → เรียก `POST /uploads` → `PUT` ตรงไป R2 (แสดง progress bar ง่ายๆ ระหว่างอัปโหลด) → `POST /messages` พร้อม `attachmentKey`
- **Bubble แสดงผล**: `attachmentType === "image"` → แสดงรูป inline ในบับเบิล (มี max-width/max-height กัน layout พัง) กดเพื่อเปิดดูเต็มจอ; `attachmentType === "file"` → การ์ดแสดงชื่อไฟล์ + ขนาด (format เป็น KB/MB) + ไอคอนดาวน์โหลด (ลิงก์ไปที่ `attachmentUrl` ตรงๆ, `download` attribute)
- **Push notification**: ข้อความที่ `body` เป็น null ให้ตัวหนังสือ push เป็น "ส่งรูปภาพ" หรือ "ส่งไฟล์: `<attachmentName>`" แทน (แก้ที่จุดสร้าง push payload ใน `src/routes/chat.js`)

## Drive Backup

`src/lib/drive.js#archiveUserConversations` ยังคง backup แค่ `body` เป็น JSONL เหมือนเดิม — ข้อความที่มี attachment จะถูกบันทึกลง JSONL ด้วย field เพิ่ม `{ hasAttachment: true, attachmentName }` (ไม่ backup ไบต์ไฟล์จริง) เพื่อไม่ให้ประวัติที่อ่านจาก Drive ดูเหมือนข้อความหายไปเฉยๆ — การ backup ไฟล์จริงเป็นงานแยกที่ไม่อยู่ในสโคปนี้

**ผลกระทบต่อ `pruneArchivedMessages`:** ไม่เปลี่ยนพฤติกรรม — ยังลบแถว `Message` จาก Postgres ตามเดิมเมื่อทุกฝ่าย archive ผ่านแล้ว แปลว่าถ้าข้อความมี attachment ถูก prune ไป ไฟล์บน R2 จะกลายเป็นข้อมูลกำพร้า (ไม่มีแถว DB อ้างถึงแล้ว) — รอบนี้ยอมรับ trade-off นี้ไว้ก่อน (ไม่ implement การลบไฟล์ R2 ตอน prune) เพราะ pruning เป็นกรณีที่เกิดหลัง Drive backup เท่านั้น (ต้องเชื่อม Drive ทั้งสองฝ่าย) ซึ่งไม่ใช่ default behavior ของแอป และไฟล์กำพร้าไม่กี่ไฟล์ไม่กระทบอะไรเทียบกับความซับซ้อนที่เพิ่มขึ้นถ้าจะแก้ตอนนี้

## Error Handling

- `POST /uploads`: 401 ไม่ล็อกอิน, 404 ไม่ใช่ผู้ร่วมสนทนา (ตาม pattern เดิม), 403 ไม่ได้เป็นเพื่อนกันแล้ว, 400 ขนาด/ชนิดไฟล์ไม่ผ่าน, 503 ถ้า R2 ไม่ได้ตั้งค่า
- `POST /messages` พร้อม `attachmentKey`: 400 ถ้า `HeadObject` ไม่เจอไฟล์ (ยังไม่ได้อัปโหลดจริง หรือ key ผิด) หรือขนาด/ชนิดไฟล์จริงไม่ตรงกับที่อนุญาต
- ไฟล์ที่อัปโหลดไปแล้วแต่ไม่เคยถูกผูกกับข้อความ (ผู้ใช้เลือกไฟล์แล้วปิดแอปก่อนกดส่ง) จะค้างอยู่บน R2 — รอบนี้ไม่ implement การเก็บกวาดอัตโนมัติ (เหมือนที่ยังไม่ implement การลบไฟล์กำพร้าจาก pruning ด้านบน) เพราะ storage cost ของไฟล์เดี่ยวๆ ไม่กี่ไฟล์ต่ำมาก ปล่อยเป็น manual cleanup ในอนาคตถ้าจำเป็นจริง

## Testing

- Backend: `tests/attachments.test.js` ใหม่ — mock S3 client (ไม่ยิง R2 จริงในเทส) ครอบคลุม: ขอ presigned URL สำเร็จ/ไม่ได้เป็นเพื่อน/ไฟล์เกินขนาด/ชนิดไฟล์ต้องห้าม, สร้างข้อความพร้อม attachment สำเร็จ, สร้างข้อความอ้าง key ที่ไม่มีไฟล์จริงบน R2 (400), ข้อความว่างทั้ง body และ attachment (400), GET messages คืน attachmentUrl ที่ mint สด
- Frontend: ไม่มีชุดเทสอัตโนมัติในแอปนี้ (ตามธรรมเนียมเดิม) — ตรวจด้วย `npm run lint` + `npm run build` + ทดลองใช้จริง (อัปโหลดรูป, อัปโหลดไฟล์ .exe ต้องโดนบล็อก, ไฟล์เกินขนาดต้องโดนบล็อก, สองฝั่งเห็นไฟล์แนบตรงกัน)

## Out of Scope (ยืนยันอีกครั้ง)

- วิดีโอ, เสียง/voice message, สติ๊กเกอร์แบบไฟล์ — สเปคแยกต่างหาก
- การลบไฟล์ R2 อัตโนมัติเมื่อข้อความถูก prune จาก Postgres หรือถูกลบทิ้ง
- การ backup ไฟล์แนบจริงขึ้น Google Drive (บันทึกแค่ชื่อไฟล์ไว้ใน JSONL)
- การบีบอัด/ย่อขนาดรูปภาพก่อนอัปโหลด (อัปโหลดไฟล์ต้นฉบับตรงๆ)
