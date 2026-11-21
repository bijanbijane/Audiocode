/**
 * AVAPARDAZ — ADOBE AUDITION EXTENDSCRIPT HOST BRIDGE (v1.0.0)
 *
 * Strictly scoped to verified Adobe Audition ExtendScript DOM properties.
 * - Reads active document metadata (name, fullName path, sampleRate, channels, duration)
 * - Never fabricates undocumented Premiere/Photoshop APIs
 * - Never silently substitutes a different file than the user's active document
 * - Escapes all strings safely into JSON before returning to the CEP panel
 */

function avpJsonEscape(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function avpGetActiveDocumentInfo() {
  try {
    if (typeof app === "undefined" || !app.activeDocument) {
      return '{"ok":false,"code":"NO_ACTIVE_DOCUMENT","message":"هیچ فایل صوتی فعالی در Adobe Audition باز نیست."}';
    }
    var doc = app.activeDocument;
    var docName = doc.displayName || doc.name || "Untitled";
    var fullPath = "";
    try {
      if (doc.fullName && doc.fullName.fsName) {
        fullPath = String(doc.fullName.fsName);
      } else if (typeof doc.fullName === "string") {
        fullPath = doc.fullName;
      }
    } catch (ePath) {
      fullPath = "";
    }

    var sampleRate = 0;
    try {
      sampleRate = Number(doc.sampleRate || 0);
    } catch (eSr) {}

    var channels = 0;
    try {
      channels = Number(doc.channels || 0);
    } catch (eCh) {}

    var durationSec = 0;
    try {
      if (typeof doc.duration === "number") {
        durationSec = doc.duration;
      } else if (typeof doc.length === "number" && sampleRate > 0) {
        durationSec = doc.length / sampleRate;
      }
    } catch (eDur) {}

    var selectionStartSec = null;
    var selectionEndSec = null;
    try {
      if (doc.selection && typeof doc.selection.start === "number" && typeof doc.selection.end === "number") {
        if (doc.selection.end > doc.selection.start) {
          selectionStartSec = sampleRate > 0 ? doc.selection.start / sampleRate : doc.selection.start;
          selectionEndSec = sampleRate > 0 ? doc.selection.end / sampleRate : doc.selection.end;
        }
      }
    } catch (eSel) {}

    var fileSizeBytes = 0;
    var fileModifiedMs = 0;
    try {
      if (fullPath) {
        var fObj = new File(fullPath);
        if (fObj.exists) {
          fileSizeBytes = Number(fObj.length || 0);
          if (fObj.modified && typeof fObj.modified.getTime === "function") {
            fileModifiedMs = Number(fObj.modified.getTime() || 0);
          }
        }
      }
    } catch (eMeta) {}

    return (
      '{"ok":true' +
      ',"displayName":"' + avpJsonEscape(docName) + '"' +
      ',"filePath":"' + avpJsonEscape(fullPath) + '"' +
      ',"fileSizeBytes":' + (isNaN(fileSizeBytes) ? 0 : fileSizeBytes) +
      ',"fileModifiedMs":' + (isNaN(fileModifiedMs) ? 0 : fileModifiedMs) +
      ',"sampleRateHz":' + (isNaN(sampleRate) ? 0 : sampleRate) +
      ',"channelCount":' + (isNaN(channels) ? 0 : channels) +
      ',"durationSec":' + (isNaN(durationSec) ? 0 : durationSec) +
      ',"selectionStartSec":' + (selectionStartSec === null ? "null" : selectionStartSec) +
      ',"selectionEndSec":' + (selectionEndSec === null ? "null" : selectionEndSec) +
      ',"hostVersion":"' + avpJsonEscape(app.version || "unknown") + '"' +
      "}"
    );
  } catch (err) {
    return '{"ok":false,"code":"EXTENDSCRIPT_ERROR","message":"' + avpJsonEscape(err.message || err) + '"}';
  }
}

function avpWriteTextFile(targetPath, utf8Content) {
  try {
    if (!targetPath || String(targetPath).indexOf("..") !== -1) {
      return '{"ok":false,"code":"INVALID_EXPORT_PATH","message":"مسیر ذخیره‌سازی نامعتبر است."}';
    }
    var outFile = new File(targetPath);
    outFile.encoding = "UTF-8";
    if (!outFile.open("w")) {
      return '{"ok":false,"code":"FILE_OPEN_FAILED","message":"امکان باز کردن فایل خروجی وجود ندارد."}';
    }
    outFile.write(utf8Content);
    outFile.close();
    return '{"ok":true,"path":"' + avpJsonEscape(outFile.fsName) + '"}';
  } catch (err) {
    return '{"ok":false,"code":"FILE_WRITE_ERROR","message":"' + avpJsonEscape(err.message || err) + '"}';
  }
}
