const fs = require('fs');
const path = require('path');

const sourceCredential = require('./source-service-account.json');
const targetCredential = require('./target-service-account.json');

const MANIFEST_FILE = path.join(
  __dirname,
  'migration-manifest.json'
);

const manifest = JSON.parse(
  fs.readFileSync(MANIFEST_FILE, 'utf8')
);

for (const chatroom of manifest.chatrooms) {
  chatroom.status = 'pending';
  chatroom.migrated = 0;
  chatroom.skipped = 0;
  chatroom.failed = 0;
  chatroom.updatedAt = null;

  // Remove information from previous destination
  delete chatroom.targetMessages;
}

manifest.scannedAt = null;

manifest.sourceProject = sourceCredential.project_id;
manifest.targetProject = targetCredential.project_id;

fs.writeFileSync(
  MANIFEST_FILE,
  JSON.stringify(manifest, null, 2),
  'utf8'
);


console.log('========================================');
console.log('MANIFEST RESET');
console.log('========================================');
console.log(`Chatrooms : ${manifest.chatrooms.length}`);
console.log('Status    : all pending');
console.log('Migrated  : 0');
console.log('Skipped   : 0');
console.log('Failed    : 0');
console.log('========================================');