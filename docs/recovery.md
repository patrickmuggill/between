# Recovering saved drafts

Between keeps drafts in this browser's local storage, for this app address. They are not synced to another browser or device.

If some saved data cannot be opened, Between recovers readable drafts individually. Before saving the recovered collection, it preserves the exact original data in a separate local backup. The warning offers **Download original data** to save a recovery copy as `between-original-drafts.json`. This file may include drafts the editor could not open. It is data for recovery, not an importable document or a guarantee that every damaged draft can be repaired.

If the backup cannot be saved, Between leaves the original collection untouched and pauses saving for that session. You can still write, copy, and export. Download the original data and export any new writing before reloading or closing the tab. Freeing storage alone does not resume saving in the current session. After securing those copies, reload to retry recovery.

If storage cannot be read at all, Between pauses saving and cannot offer a download of the unreadable data. Do not clear site data to troubleshoot: that would remove the drafts. Export any new writing before changing browser settings or reloading.

## Finding a backup after reloading

After a successful recovery, reloading opens the repaired collection and the warning may no longer appear. The original backup remains in the same browser's local storage. Between never automatically deletes these backups or replaces a distinct older backup.

To retrieve one:

1. Open Between at the same address, in the same browser profile used during recovery.
2. Open the browser's developer tools. In Chrome, choose **Application → Local storage**, then select Between's address.
3. Look for `between.documents.v1.recovery`. Additional distinct backups use `.recovery.1`, `.recovery.2`, and so on. These numbers distinguish backups; they are not dates. The unsuffixed `between.documents.v1` entry is the current collection, not the backup.
4. Select a recovery entry and copy its full value into a local plain-text file, saving it with a `.json` extension. Do not edit or delete the storage entries. Keep a separate copy before attempting repairs.

The backup contains the original JSON text, including malformed or rejected records, exactly as it was read. The normal editor export is Markdown for the current draft and is not a substitute for this original-data backup.

These backups have the same privacy limits as ordinary drafts: they are not encrypted by Between, and clearing browser/site data can delete them. Keep downloads private. Do not paste personal drafts into a public issue when asking for help; use synthetic examples instead.
