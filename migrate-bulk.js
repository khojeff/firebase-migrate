const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const sourceCredential = require('./source-service-account.json');
const targetCredential = require('./target-service-account.json');

const MANIFEST_FILE = path.join(__dirname, 'migration-manifest.json');
const SELECTION_FILE = path.join(__dirname, 'migration-selection.json');
const ERROR_FILE = path.join(__dirname, 'migration-errors.json');

// ============================================================
// FIREBASE
// ============================================================

const sourceApp = admin.initializeApp(
  {
    credential: admin.credential.cert(sourceCredential),
  },
  'bulk-source'
);

const targetApp = admin.initializeApp(
  {
    credential: admin.credential.cert(targetCredential),
  },
  'bulk-target'
);

const sourceDb = sourceApp.firestore();
const targetDb = targetApp.firestore();

// ============================================================
// JSON HELPERS
// ============================================================

function readJson(file) {
  if (!fs.existsSync(file)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  // Atomic-ish write:
  // write temporary file first, then rename.
  const tempFile = `${file}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  fs.renameSync(tempFile, file);
}

function loadManifest() {
  const manifest = readJson(MANIFEST_FILE);

  if (!manifest) {
    throw new Error(
      'migration-manifest.json not found. Run scan first.'
    );
  }

  return manifest;
}

function loadErrors() {
  return readJson(ERROR_FILE) || [];
}

function getSelectionIds() {
  const selection = readJson(SELECTION_FILE);

  if (
    !selection ||
    !selection.collection ||
    !Array.isArray(selection.collection.ids)
  ) {
    return [];
  }

  // Remove empty values + duplicate IDs
  return [
    ...new Set(
      selection.collection.ids
        .filter(Boolean)
        .map((id) => String(id).trim())
        .filter(Boolean)
    ),
  ];
}

function saveSelectionIds(ids) {
  writeJson(SELECTION_FILE, {
    collection: {
      ids,
    },
  });
}

function removeSelectionId(id) {
  const ids = getSelectionIds();

  const remainingIds = ids.filter(
    (selectionId) => selectionId !== id
  );

  saveSelectionIds(remainingIds);
}

// ============================================================
// MANIFEST SUMMARY
// ============================================================

function updateManifestSummary(manifest) {
  manifest.summary = {
    chatrooms: manifest.chatrooms.length,

    messages: manifest.chatrooms.reduce(
      (total, item) => total + (item.sourceMessages || 0),
      0
    ),
  };
}

// ============================================================
// SCAN
// ============================================================

async function scan() {
  console.log('');
  console.log('========================================');
  console.log('FIREBASE BULK SCAN');
  console.log('========================================');
  console.log(`Source : ${sourceCredential.project_id}`);
  console.log(`Target : ${targetCredential.project_id}`);
  console.log('');

  const selectionIds = getSelectionIds();

  // ==========================================================
  // SAFETY
  //
  // NEVER perform global scan when selection is empty.
  // This protects Firestore read quota.
  // ==========================================================

  if (selectionIds.length === 0) {
    console.log('SCAN CANCELLED');
    console.log('');
    console.log('migration-selection.json contains no IDs.');
    console.log('No Firestore reads were performed.');
    console.log('Manifest was not modified.');
    console.log('');

    return;
  }

  console.log(`Selected IDs : ${selectionIds.length}`);
  console.log('');

  // ==========================================================
  // LOAD EXISTING MANIFEST
  // ==========================================================

  let manifest = readJson(MANIFEST_FILE);

  // First scan
  if (!manifest) {
    manifest = {
      sourceProject: sourceCredential.project_id,
      targetProject: targetCredential.project_id,
      scannedAt: null,

      summary: {
        chatrooms: 0,
        messages: 0,
      },

      chatrooms: [],
    };
  }

  // ==========================================================
  // SAFETY CHECK
  // ==========================================================

  if (
    manifest.sourceProject !== sourceCredential.project_id ||
    manifest.targetProject !== targetCredential.project_id
  ) {
    throw new Error(
      'Manifest project does not match current SOURCE/TARGET credentials.'
    );
  }

  const manifestMap = new Map(
    manifest.chatrooms.map((item) => [item.id, item])
  );

  let current = 0;

  // ==========================================================
  // SCAN ONLY SELECTED IDs
  // ==========================================================

  for (const id of selectionIds) {
    current++;

    console.log(
      `[${current}/${selectionIds.length}] Scanning ${id} ...`
    );

    try {
      const snapshot = await sourceDb
        .collection('Messages')
        .doc(id)
        .collection('messages')
        .get();

      const sourceMessages = snapshot.size;

      const existing = manifestMap.get(id);

      // ======================================================
      // EXISTING MANIFEST ENTRY
      //
      // IMPORTANT:
      // Do NOT reset:
      //
      // status
      // migrated
      // skipped
      // failed
      //
      // Only refresh source information.
      // ======================================================

      if (existing) {
        existing.sourceMessages = sourceMessages;
        existing.lastScannedAt = new Date().toISOString();

        console.log(
          `  Found ${sourceMessages} messages -> manifest updated`
        );
      }

      // ======================================================
      // NEW MANIFEST ENTRY
      // ======================================================

      else {
        const newItem = {
          id,
          sourceMessages,

          status: 'pending',

          migrated: 0,
          skipped: 0,
          failed: 0,

          updatedAt: null,
          lastScannedAt: new Date().toISOString(),
        };

        manifest.chatrooms.push(newItem);
        manifestMap.set(id, newItem);

        console.log(
          `  Found ${sourceMessages} messages -> added to manifest`
        );
      }

      // Save after every chatroom.
      //
      // If scan gets interrupted, previous scanned IDs
      // are already safely stored.

      updateManifestSummary(manifest);

      manifest.scannedAt = new Date().toISOString();

      writeJson(MANIFEST_FILE, manifest);

      // Sekarang aman menghapus ID dari selection.
        removeSelectionId(id);

    } catch (error) {
      console.error(
        `  FAILED -> ${error.message}`
      );
      throw error;

      // Do not destroy existing manifest state.
    }
  }

  updateManifestSummary(manifest);

  manifest.scannedAt = new Date().toISOString();

  writeJson(MANIFEST_FILE, manifest);

  console.log('');
  console.log('========================================');
  console.log('SCAN FINISHED');
  console.log('========================================');
  console.log(`Scanned IDs        : ${selectionIds.length}`);
  console.log(`Manifest Chatrooms : ${manifest.summary.chatrooms}`);
  console.log(`Manifest Messages  : ${manifest.summary.messages}`);
  console.log('');
  console.log('No destination data was modified.');
  console.log('========================================');
}

// ============================================================
// STATUS
// ============================================================

function status() {
  const manifest = loadManifest();

  const summary = {
    done: 0,
    pending: 0,
    processing: 0,
    partial: 0,
    failed: 0,

    migrated: 0,
    skipped: 0,
    messageFailed: 0,
  };

  for (const chatroom of manifest.chatrooms) {
    if (summary[chatroom.status] !== undefined) {
      summary[chatroom.status]++;
    }

    summary.migrated += chatroom.migrated || 0;
    summary.skipped += chatroom.skipped || 0;
    summary.messageFailed += chatroom.failed || 0;
  }

  console.log('');
  console.log('========================================');
  console.log('FIREBASE MIGRATION STATUS');
  console.log('========================================');

  console.log(`Source : ${manifest.sourceProject}`);
  console.log(`Target : ${manifest.targetProject}`);

  console.log('');
  console.log(`Chatrooms : ${manifest.summary.chatrooms}`);
  console.log(`Messages  : ${manifest.summary.messages}`);

  console.log('');
  console.log(`Done       : ${summary.done}`);
  console.log(`Pending    : ${summary.pending}`);
  console.log(`Processing : ${summary.processing}`);
  console.log(`Partial    : ${summary.partial}`);
  console.log(`Failed     : ${summary.failed}`);

  console.log('');
  console.log(`Migrated   : ${summary.migrated}`);
  console.log(`Skipped    : ${summary.skipped}`);
  console.log(`Msg Failed : ${summary.messageFailed}`);

  console.log('========================================');
}

// ============================================================
// GET CHATROOMS FOR MIGRATION
// ============================================================

function getSelectedChatrooms(manifest) {
  const selectionIds = getSelectionIds();

  // ==========================================================
  // EMPTY SELECTION
  //
  // Unlike scan:
  //
  // migrate + empty selection
  // = migrate ALL unfinished manifest entries
  // ==========================================================

  if (selectionIds.length === 0) {
    console.log('Selection : EMPTY');
    console.log('Mode      : MANIFEST');
    console.log('');

    return manifest.chatrooms.filter(
      (item) => item.status !== 'done'
    );
  }

  // ==========================================================
  // SELECTION MODE
  // ==========================================================

  const manifestMap = new Map(
    manifest.chatrooms.map((item) => [item.id, item])
  );

  const selected = [];
  const notFound = [];

  for (const id of selectionIds) {
    const chatroom = manifestMap.get(id);

    if (!chatroom) {
      notFound.push(id);
      continue;
    }

    selected.push(chatroom);
  }

  console.log(`Selection : ${selectionIds.length} IDs`);
  console.log(`Valid     : ${selected.length}`);
  console.log(`Not Found : ${notFound.length}`);

  if (notFound.length > 0) {
    console.log('');
    console.log('IDs NOT FOUND IN MANIFEST:');

    for (const id of notFound) {
      console.log(`- ${id}`);
    }
  }

  console.log('');

  return selected;
}

// ============================================================
// MIGRATE ONE CHATROOM
// ============================================================

async function migrateChatroom(chatroom, manifest, errors) {
  console.log('');
  console.log('----------------------------------------');
  console.log(`Chatroom : ${chatroom.id}`);
  console.log(`Status   : ${chatroom.status}`);
  console.log('----------------------------------------');

  // ==========================================================
  // DONE = SKIP TOTAL
  // No Firebase read.
  // ==========================================================

  if (chatroom.status === 'done') {
    console.log('SKIP -> chatroom already done');
    return;
  }

  chatroom.status = 'processing';
  chatroom.updatedAt = new Date().toISOString();

  writeJson(MANIFEST_FILE, manifest);

  const sourceMessagesRef = sourceDb
    .collection('Messages')
    .doc(chatroom.id)
    .collection('messages');

  const targetMessagesRef = targetDb
    .collection('Messages')
    .doc(chatroom.id)
    .collection('messages');

  try {
    // ========================================================
    // STEP 1
    // COUNT SOURCE + TARGET
    //
    // This does NOT download all message documents.
    // ========================================================

    const [sourceCountSnapshot, targetCountSnapshot] =
      await Promise.all([
        sourceMessagesRef.count().get(),
        targetMessagesRef.count().get(),
      ]);

    const sourceCount = sourceCountSnapshot.data().count;
    const targetCount = targetCountSnapshot.data().count;

    console.log(`Source Count : ${sourceCount}`);
    console.log(`Target Count : ${targetCount}`);

    chatroom.sourceMessages = sourceCount;
    chatroom.targetMessages = targetCount;

    // ========================================================
    // CASE 1
    // SOURCE EMPTY
    // ========================================================

    if (sourceCount === 0) {
      console.log('SOURCE EMPTY -> SKIP');

      chatroom.status = 'done';
      chatroom.migrated = 0;
      chatroom.skipped = 0;
      chatroom.failed = 0;
      chatroom.updatedAt = new Date().toISOString();

      updateManifestSummary(manifest);
      writeJson(MANIFEST_FILE, manifest);

      return;
    }

    // ========================================================
    // CASE 2
    // TARGET COUNT >= SOURCE COUNT
    //
    // According to our relaxed verification rule,
    // consider this complete.
    //
    // NO message documents are downloaded.
    // ========================================================

    if (targetCount >= sourceCount) {
      console.log('TARGET COUNT >= SOURCE COUNT');
      console.log('SKIP WHOLE CHATROOM -> DONE');

      chatroom.status = 'done';
      chatroom.migrated = 0;
      chatroom.skipped = sourceCount;
      chatroom.failed = 0;
      chatroom.updatedAt = new Date().toISOString();

      updateManifestSummary(manifest);
      writeJson(MANIFEST_FILE, manifest);

      return;
    }

    // ========================================================
    // CASE 3
    // TARGET EMPTY
    //
    // Read SOURCE only.
    // Do NOT perform target.get() for every message.
    // ========================================================

    if (targetCount === 0) {
      console.log('');
      console.log('TARGET EMPTY');
      console.log('Migrating all source messages...');
      console.log('');

      const sourceSnapshot = await sourceMessagesRef.get();

      let migrated = 0;
      let processed = 0;

      for (const sourceDoc of sourceSnapshot.docs) {
        processed++;

        try {
          await targetMessagesRef
            .doc(sourceDoc.id)
            .set(sourceDoc.data());

          migrated++;

          console.log(
            `[${processed}/${sourceSnapshot.size}] ${sourceDoc.id} -> MIGRATED`
          );
        } catch (error) {
          // Save current progress
          chatroom.status = 'partial';
          chatroom.migrated = migrated;
          chatroom.skipped = 0;
          chatroom.failed = 1;
          chatroom.updatedAt = new Date().toISOString();

          errors.push({
            chatroomId: chatroom.id,
            messageId: sourceDoc.id,
            error: error.message,
            at: new Date().toISOString(),
          });

          writeJson(ERROR_FILE, errors);
          writeJson(MANIFEST_FILE, manifest);

          console.error(
            `[${processed}/${sourceSnapshot.size}] ${sourceDoc.id} -> FAILED`
          );

          // STOP entire migration
          throw error;
        }
      }

      chatroom.status = 'done';
      chatroom.migrated = migrated;
      chatroom.skipped = 0;
      chatroom.failed = 0;
      chatroom.targetMessages = migrated;
      chatroom.updatedAt = new Date().toISOString();

      updateManifestSummary(manifest);
      writeJson(MANIFEST_FILE, manifest);

      console.log('');
      console.log(`Migrated : ${migrated}`);
      console.log('Status   : done');

      return;
    }

    // ========================================================
    // CASE 4
    // PARTIAL TARGET
    //
    // Example:
    //
    // source = 1000
    // target = 950
    //
    // Compare IDs and migrate missing messages only.
    // ========================================================

    console.log('');
    console.log('PARTIAL TARGET');
    console.log('Comparing message IDs...');
    console.log('');

    // Read target documents so we know existing IDs.
    const targetSnapshot = await targetMessagesRef.get();

    const targetIds = new Set(
      targetSnapshot.docs.map((doc) => doc.id)
    );

    // Read source documents.
    const sourceSnapshot = await sourceMessagesRef.get();

    let migrated = 0;
    let skipped = 0;
    let processed = 0;

    for (const sourceDoc of sourceSnapshot.docs) {
      processed++;

      // Already exists in destination.
      // No additional target.get() needed.
      if (targetIds.has(sourceDoc.id)) {
        skipped++;
        continue;
      }

      try {
        await targetMessagesRef
          .doc(sourceDoc.id)
          .set(sourceDoc.data());

        migrated++;

        console.log(
          `[${processed}/${sourceSnapshot.size}] ${sourceDoc.id} -> MIGRATED`
        );
      } catch (error) {
        chatroom.status = 'partial';
        chatroom.migrated = migrated;
        chatroom.skipped = skipped;
        chatroom.failed = 1;
        chatroom.updatedAt = new Date().toISOString();

        errors.push({
          chatroomId: chatroom.id,
          messageId: sourceDoc.id,
          error: error.message,
          at: new Date().toISOString(),
        });

        writeJson(ERROR_FILE, errors);
        writeJson(MANIFEST_FILE, manifest);

        console.error(
          `[${processed}/${sourceSnapshot.size}] ${sourceDoc.id} -> FAILED`
        );

        // STOP entire migration
        throw error;
      }
    }

    // ========================================================
    // SUCCESS
    // ========================================================

    chatroom.status = 'done';
    chatroom.migrated = migrated;
    chatroom.skipped = skipped;
    chatroom.failed = 0;

    // Destination should now contain the source messages.
    chatroom.targetMessages = targetCount + migrated;

    chatroom.updatedAt = new Date().toISOString();

    updateManifestSummary(manifest);
    writeJson(MANIFEST_FILE, manifest);

    console.log('');
    console.log(`Migrated : ${migrated}`);
    console.log(`Skipped  : ${skipped}`);
    console.log('Status   : done');
  } catch (error) {
    // ========================================================
    // COUNT / READ / OTHER FIREBASE ERROR
    // ========================================================

    if (chatroom.status !== 'partial') {
      chatroom.status = 'failed';
      chatroom.failed = 1;
      chatroom.updatedAt = new Date().toISOString();

      errors.push({
        chatroomId: chatroom.id,
        messageId: null,
        error: error.message,
        at: new Date().toISOString(),
      });

      writeJson(ERROR_FILE, errors);
      writeJson(MANIFEST_FILE, manifest);
    }

    throw error;
  }
}

// ============================================================
// MIGRATE
// ============================================================

async function migrate() {
  const manifest = loadManifest();
  const errors = loadErrors();

  console.log('');
  console.log('========================================');
  console.log('FIREBASE BULK MIGRATION');
  console.log('========================================');
  console.log(`Source : ${sourceCredential.project_id}`);
  console.log(`Target : ${targetCredential.project_id}`);
  console.log('');

  // ==========================================================
  // PROJECT SAFETY CHECK
  // ==========================================================

  if (
    manifest.sourceProject !== sourceCredential.project_id ||
    manifest.targetProject !== targetCredential.project_id
  ) {
    throw new Error(
      'Manifest project does not match current SOURCE/TARGET credentials.'
    );
  }

  const selected = getSelectedChatrooms(manifest);

  if (selected.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  console.log(
    `Will process ${selected.length} chatroom(s).`
  );

  let current = 0;

  // ==========================================================
  // PROCESS SEQUENTIALLY
  // ==========================================================

  for (const chatroom of selected) {
    current++;

    console.log('');
    console.log(
      `========== CHATROOM ${current}/${selected.length} ==========`
    );

    try {
        await migrateChatroom(
            chatroom,
            manifest,
            errors
        );
        } catch (error) {
            console.error('');
            console.error('========================================');
            console.error('MIGRATION STOPPED');
            console.error('========================================');
            console.error(`Chatroom : ${chatroom.id}`);
            console.error(`Error    : ${error.message}`);
            console.error('');
            console.error('No further chatrooms will be processed.');
            console.error('========================================');

            throw error;
        }
    }

  console.log('');
  console.log('========================================');
  console.log('BULK MIGRATION FINISHED');
  console.log('========================================');

  status();
}

// ============================================================
// COMMAND
// ============================================================

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'scan':
      await scan();
      break;

    case 'status':
      status();
      break;

    case 'migrate':
      await migrate();
      break;

    default:
      console.log('');
      console.log('Usage:');
      console.log('');
      console.log('  node migrate-bulk.js scan');
      console.log('  node migrate-bulk.js status');
      console.log('  node migrate-bulk.js migrate');
      console.log('');

      process.exitCode = 1;
  }
}

// ============================================================
// START
// ============================================================

main()
  .catch((error) => {
    // console.error('');
    // console.error('========================================');
    // console.error('FATAL ERROR');
    // console.error('========================================');
    // console.error(error);
    // console.error('========================================');

    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([
      sourceApp.delete(),
      targetApp.delete(),
    ]);
  });