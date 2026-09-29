# Firebase Firestore Message Migration

Simple Node.js v20 script untuk migrate Firestore messages dari Firebase SOURCE ke Firebase TARGET.

Migration path:

```text
SOURCE
Messages/{DOCUMENT_ID}/messages/*

↓

TARGET
Messages/{DOCUMENT_ID}/messages/*
```

Jika `message ID` sudah ada di TARGET, message akan di-**SKIP** dan tidak di-overwrite.

---

## 1. Requirements

- Node.js v20
- npm
- Access ke Firebase SOURCE
- Access ke Firebase TARGET

Check Node.js:

```bash
node -v
npm -v
```

Expected:

```text
v20.x.x
```

---

## 2. Installation

Buat project:

```bash
mkdir firebase-migrate
cd firebase-migrate
```

Initialize npm:

```bash
npm init -y
```

Install Firebase Admin SDK:

```bash
npm install firebase-admin
```

---

## 3. Generate Firebase Service Account

### SOURCE Firebase

1. Buka Firebase Console:
   https://console.firebase.google.com/

2. Pilih project Firebase SOURCE.

3. Buka:

```text
Project Settings
→ Service accounts
→ Firebase Admin SDK
```

4. Klik:

```text
Generate new private key
```

5. Download JSON.

6. Rename menjadi:

```text
source-service-account.json
```

### TARGET Firebase

Lakukan langkah yang sama pada project Firebase TARGET.

Rename file menjadi:

```text
target-service-account.json
```

---

## 4. Project Structure

```text
firebase-migrate/
├── migrate.js
├── source-service-account.json
├── target-service-account.json
├── package.json
└── node_modules/
```

---

## 5. Protect Service Account

Jangan commit service account ke Git.

Buat `.gitignore`:

```bash
cat > .gitignore <<'EOF'
node_modules/
source-service-account.json
target-service-account.json
EOF
```

Service account JSON mengandung private key dan harus dianggap sebagai credential rahasia.

---

## 6. Verify Firebase Projects

Pastikan SOURCE dan TARGET tidak tertukar:

```bash
grep '"project_id"' source-service-account.json
grep '"project_id"' target-service-account.json
```

Contoh:

```text
"project_id": "firebase-old"
"project_id": "firebase-new"
```

Pastikan project pertama adalah SOURCE dan project kedua adalah TARGET.

---

## 7. Run Migration

Format:

```bash
node migrate.js <DOCUMENT_ID>
```

Contoh:

```bash
node migrate.js uMtjHHOKXe9Q2FFXXXLC
```

Script akan membaca:

```text
Messages/uMtjHHOKXe9Q2FFXXXLC/messages/*
```

dari SOURCE dan memasukkannya ke path yang sama pada TARGET.

---

## 8. Existing Messages

Jika message ID belum ada:

```text
msg001 -> MIGRATED
```

Jika message ID sudah ada:

```text
msg002 -> SKIP (already exists)
```

Existing document tidak akan diubah atau di-overwrite.

---

## 9. Example Result

```text
========================================
FIREBASE MESSAGE MIGRATION
========================================
Document : uMtjHHOKXe9Q2FFXXXLC

Found 5 messages.

[1/5] msg001 -> MIGRATED
[2/5] msg002 -> SKIP (already exists)
[3/5] msg003 -> MIGRATED
[4/5] msg004 -> MIGRATED
[5/5] msg005 -> SKIP (already exists)

========================================
MIGRATION FINISHED
========================================
Document : uMtjHHOKXe9Q2FFXXXLC

Found    : 5
Migrated : 3
Skipped  : 2
Failed   : 0
========================================
```

Migration selesai jika:

```text
Failed : 0
```