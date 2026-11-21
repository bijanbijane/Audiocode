/**
 * AVAPARDAZ — ADOBE AUDITION CEP PANEL CLIENT (v1.0.0)
 *
 * Strictly communicates with the single AVAPARDAZ Local Companion Service over
 * loopback HMAC-authenticated IPC v1.0.0. Zero ASR inference logic is duplicated here.
 * Security: uses textContent / DOM construction only (never innerHTML with transcript data).
 */
(function () {
  "use strict";

  var state = {
    companionUrl: "http://127.0.0.1:47291/api/v2/companion",
    sessionId: null,
    sessionToken: null,
    activeJobId: null,
    activeSourceIdentity: null,
    currentAuditionSourceIdentity: null,
    pollTimer: null,
    selectedFileBase64: null,
    selectedFileName: "",
    segments: [],
    undoStack: [],
    redoStack: [],
  };

  function persistActiveJob() {
    try {
      if (state.activeJobId) {
        localStorage.setItem(
          "avp_cep_active_job_v1",
          JSON.stringify({
            jobId: state.activeJobId,
            sourceIdentity: state.activeSourceIdentity,
          })
        );
      } else {
        localStorage.removeItem("avp_cep_active_job_v1");
      }
    } catch (_e) {}
  }

  function isSourceIdentityMatching(expected, current) {
    if (!expected || !current) return true;
    if (expected.filePath && current.filePath && expected.filePath !== current.filePath) {
      return false;
    }
    if (expected.fileSizeBytes && current.fileSizeBytes && expected.fileSizeBytes !== current.fileSizeBytes) {
      return false;
    }
    if (expected.fileModifiedMs && current.fileModifiedMs && expected.fileModifiedMs !== current.fileModifiedMs) {
      return false;
    }
    return true;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function makeNonce() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "cep_" + Date.now() + "_" + Math.random().toString(36).slice(2, 12);
  }

  function showNotice(msg, isError) {
    var el = $("workspaceNotice");
    el.hidden = false;
    el.textContent = msg;
    el.className = isError ? "notice error" : "notice";
  }

  function saveDraftLocal() {
    try {
      localStorage.setItem("avp_cep_draft_segments_v1", JSON.stringify(state.segments));
    } catch (_e) {}
  }

  function restoreDraftLocal() {
    try {
      var raw = localStorage.getItem("avp_cep_draft_segments_v1");
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          state.segments = parsed;
          renderSegments();
        }
      }
    } catch (_e) {}
  }

  function pushUndoSnapshot() {
    state.undoStack.push(JSON.stringify(state.segments));
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    updateUndoButtons();
  }

  function updateUndoButtons() {
    $("btnUndo").disabled = state.undoStack.length === 0;
    $("btnRedo").disabled = state.redoStack.length === 0;
  }

  async function ensureHandshake() {
    if (state.sessionId && state.sessionToken) return;
    var resp = await fetch(state.companionUrl + "/handshake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ipc_protocol_version: "1.0.0",
        host_id: "adobe-audition",
        host_version: "24.0",
        panel_version: "1.0.0",
        host_adapter_version: "1.0.0",
        expected_contract_version: "2.0.0",
      }),
    });
    var data = await resp.json();
    if (!resp.ok || !data.compatible || !data.session_token) {
      throw new Error((data.incompatibility_reasons || []).join("; ") || "Handshake rejected");
    }
    state.sessionId = data.session_id;
    state.sessionToken = data.session_token;
  }

  async function sendIpc(command, payload) {
    await ensureHandshake();
    var resp = await fetch(state.companionUrl + "/ipc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + state.sessionToken,
      },
      body: JSON.stringify({
        ipc_protocol_version: "1.0.0",
        session_id: state.sessionId,
        nonce: makeNonce(),
        request_id: makeNonce(),
        timestamp_ms: Date.now(),
        expires_at_ms: Date.now() + 60000,
        execution_mode: "audition-cep",
        command: command,
        payload: payload || {},
      }),
    });
    if (resp.status === 401) {
      state.sessionId = null;
      state.sessionToken = null;
      await ensureHandshake();
      return sendIpc(command, payload);
    }
    var data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.message || data.error || "IPC request failed");
    }
    return data;
  }

  async function refreshHealth() {
    var dot = $("engineDot");
    var statusText = $("engineStatusText");
    var select = $("modelSelect");
    try {
      var resp = await fetch(state.companionUrl + "/health");
      var health = await resp.json();
      $("healthJson").textContent = JSON.stringify(health, null, 2);
      var models = (health.runtime && health.runtime.installedModels) || [];
      select.textContent = "";
      models.forEach(function (m) {
        var opt = document.createElement("option");
        opt.value = m.modelId;
        opt.textContent = m.displayName + " (" + m.quantization + ")";
        select.appendChild(opt);
      });
      if (health.runtime && health.runtime.available) {
        dot.className = "brand-dot ok";
        statusText.textContent = "موتور محلی آماده است (" + models.length + " مدل نصب‌شده)";
      } else {
        dot.className = "brand-dot err";
        statusText.textContent = "Companion متصل است اما مدل محلی نصب نشده است";
      }
    } catch (_err) {
      dot.className = "brand-dot err";
      statusText.textContent = "سرویس محلی Companion در دسترس نیست";
      $("healthJson").textContent = "Companion unreachable at " + state.companionUrl;
    }
  }

  function syncAuditionDocument() {
    var infoEl = $("auditionDocInfo");
    if (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function") {
      window.__adobe_cep__.evalScript("avpGetActiveDocumentInfo()", function (raw) {
        try {
          var parsed = JSON.parse(raw);
          if (!parsed.ok) {
            infoEl.textContent = parsed.message || "سند فعالی یافت نشد.";
            return;
          }
          infoEl.textContent =
            parsed.displayName +
            " | " +
            parsed.sampleRateHz +
            " Hz | " +
            parsed.channelCount +
            "ch | " +
            Number(parsed.durationSec || 0).toFixed(1) +
            "s";
          state.currentAuditionSourceIdentity = {
            displayName: parsed.displayName || "",
            filePath: parsed.filePath || "",
            fileSizeBytes: Number(parsed.fileSizeBytes || 0),
            fileModifiedMs: Number(parsed.fileModifiedMs || 0),
          };
          if (parsed.filePath) {
            $("manualFilePath").value = parsed.filePath;
          }
        } catch (_e) {
          infoEl.textContent = "خطا در خواندن پاسخ ExtendScript از Audition.";
        }
      });
    } else {
      infoEl.textContent = "محیط خارج از Adobe Audition تشخیص داده شد؛ مسیر فایل محلی یا انتخابگر فایل را به کار ببرید.";
    }
  }

  function renderSegments() {
    var list = $("segmentsList");
    var q = ($("searchInput").value || "").trim().toLowerCase();
    list.textContent = "";

    var visible = state.segments.filter(function (s) {
      return !q || (s.text || "").toLowerCase().indexOf(q) !== -1;
    });

    if (visible.length === 0) {
      var p = document.createElement("p");
      p.className = "muted";
      p.textContent = state.segments.length === 0
        ? "هنوز متنی تولید نشده است."
        : "موردی مطابق جستجو یافت نشد.";
      list.appendChild(p);
      return;
    }

    visible.forEach(function (seg) {
      var wrap = document.createElement("div");
      wrap.className = "seg-item";

      var header = document.createElement("div");
      header.className = "seg-header";

      var timeSpan = document.createElement("span");
      timeSpan.dir = "ltr";
      timeSpan.textContent = Number(seg.startSec).toFixed(2) + "s → " + Number(seg.endSec).toFixed(2) + "s";

      var actions = document.createElement("div");
      actions.className = "row";

      var btnSplit = document.createElement("button");
      btnSplit.className = "btn sm secondary";
      btnSplit.textContent = "تقسیم";
      btnSplit.addEventListener("click", function () {
        var idx = state.segments.indexOf(seg);
        if (idx === -1) return;
        var words = (seg.text || "").trim().split(/\s+/);
        if (words.length < 2) return;
        pushUndoSnapshot();
        var mid = Math.floor(words.length / 2);
        var midTime = Number(((seg.startSec + seg.endSec) / 2).toFixed(3));
        var first = Object.assign({}, seg, { endSec: midTime, text: words.slice(0, mid).join(" ") });
        var second = Object.assign({}, seg, {
          id: seg.id + "_b",
          startSec: midTime,
          text: words.slice(mid).join(" "),
        });
        state.segments.splice(idx, 1, first, second);
        saveDraftLocal();
        renderSegments();
      });

      var btnMerge = document.createElement("button");
      btnMerge.className = "btn sm secondary";
      btnMerge.textContent = "ادغام با بعدی";
      btnMerge.addEventListener("click", function () {
        var idx = state.segments.indexOf(seg);
        if (idx === -1 || idx >= state.segments.length - 1) return;
        pushUndoSnapshot();
        var next = state.segments[idx + 1];
        state.segments[idx] = Object.assign({}, seg, {
          endSec: next.endSec,
          text: (seg.text + " " + next.text).trim(),
        });
        state.segments.splice(idx + 1, 1);
        saveDraftLocal();
        renderSegments();
      });

      actions.appendChild(btnSplit);
      actions.appendChild(btnMerge);
      header.appendChild(timeSpan);
      header.appendChild(actions);

      var ta = document.createElement("textarea");
      ta.className = "seg-text";
      ta.dir = "auto";
      ta.value = seg.text || "";
      ta.addEventListener("change", function () {
        pushUndoSnapshot();
        seg.text = ta.value;
        saveDraftLocal();
      });

      wrap.appendChild(header);
      wrap.appendChild(ta);
      list.appendChild(wrap);
    });
  }

  async function startTranscription() {
    var filePath = $("manualFilePath").value.trim();
    var sourceIdentity = state.currentAuditionSourceIdentity
      ? Object.assign({}, state.currentAuditionSourceIdentity, {
          filePath: filePath || state.currentAuditionSourceIdentity.filePath,
        })
      : filePath
      ? { filePath: filePath }
      : { displayName: state.selectedFileName || "audio.wav" };
    var payload = {
      modelId: $("modelSelect").value || undefined,
      languageHint: $("languageSelect").value || "auto",
      numThreads: Number($("cpuThreadsInput").value) || 4,
      sourceIdentity: sourceIdentity,
    };
    if (filePath) {
      payload.filePath = filePath;
    } else if (state.selectedFileBase64) {
      payload.audioBase64 = state.selectedFileBase64;
      payload.filename = state.selectedFileName || "audio.wav";
    } else {
      showNotice("ابتدا فایل صوتی یا سند فعال Audition را انتخاب کنید.", true);
      return;
    }

    $("btnStartJob").disabled = true;
    $("btnCancelJob").disabled = false;
    $("progressWrap").hidden = false;
    $("progressFill").style.width = "5%";
    $("progressLabel").textContent = "در حال ارسال به موتور محلی...";

    try {
      var res = await sendIpc("JOB_SUBMIT", payload);
      state.activeJobId = res.job.jobId;
      state.activeSourceIdentity = sourceIdentity;
      persistActiveJob();
      showNotice("پردازش محلی با مدل " + res.job.modelId + " آغاز شد.", false);
      pollJobStatus();
    } catch (err) {
      $("btnStartJob").disabled = false;
      $("btnCancelJob").disabled = true;
      showNotice("خطا در شروع رونویسی: " + err.message, true);
    }
  }

  function pollJobStatus() {
    if (!state.activeJobId) return;
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(async function () {
      try {
        var res = await sendIpc("JOB_STATUS", { jobId: state.activeJobId });
        var job = res.job;
        $("progressFill").style.width = Math.max(5, job.progressPct || 0) + "%";
        $("progressLabel").textContent = (job.progressPct || 0) + "٪";
        $("elapsedLabel").textContent = ((job.elapsedMs || 0) / 1000).toFixed(1) + " ثانیه";

        if (job.status === "COMPLETED" && job.result) {
          var expectedSrc = job.sourceIdentity || state.activeSourceIdentity;
          if (!isSourceIdentityMatching(expectedSrc, state.currentAuditionSourceIdentity)) {
            $("btnStartJob").disabled = false;
            $("btnCancelJob").disabled = true;
            state.activeJobId = null;
            state.activeSourceIdentity = null;
            persistActiveJob();
            showNotice(
              "SOURCE_CHANGED: سند فعال Adobe Audition در حین پردازش تغییر کرده است؛ نتیجه منقضی‌شده به‌طور خودکار اعمال نشد.",
              true
            );
            return;
          }
          pushUndoSnapshot();
          state.segments = (job.result.segments || []).map(function (s) {
            return {
              id: s.id,
              startSec: s.startSec,
              endSec: s.endSec,
              text: s.text,
              language: s.language,
              timestampGranularity: s.timestampGranularity,
              words: s.words || [],
            };
          });
          saveDraftLocal();
          renderSegments();
          $("btnStartJob").disabled = false;
          $("btnCancelJob").disabled = true;
          state.activeJobId = null;
          state.activeSourceIdentity = null;
          persistActiveJob();
          showNotice(
            "رونویسی کامل شد | RTF=" + job.result.realTimeFactor + " | زبان: " + job.result.dominantLanguage,
            false
          );
          return;
        }
        if (job.status === "CANCELLED" || job.status === "FAILED") {
          $("btnStartJob").disabled = false;
          $("btnCancelJob").disabled = true;
          state.activeJobId = null;
          state.activeSourceIdentity = null;
          persistActiveJob();
          showNotice(job.errorMessage || "پردازش متوقف شد.", true);
          return;
        }
        pollJobStatus();
      } catch (err) {
        $("btnStartJob").disabled = false;
        $("btnCancelJob").disabled = true;
        showNotice("قطع ارتباط با Companion: " + err.message, true);
      }
    }, 450);
  }

  async function tryReconnectPersistedJob() {
    try {
      var raw = localStorage.getItem("avp_cep_active_job_v1");
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || !saved.jobId) return;
      var res = await sendIpc("JOB_RECONNECT", { jobId: saved.jobId });
      if (res && res.ok && res.job) {
        state.activeJobId = res.job.jobId;
        state.activeSourceIdentity = res.job.sourceIdentity || saved.sourceIdentity || null;
        if (res.job.status === "RUNNING" || res.job.status === "QUEUED") {
          $("btnStartJob").disabled = true;
          $("btnCancelJob").disabled = false;
          $("progressWrap").hidden = false;
          showNotice("اتصال مجدد به پردازش فعال انجام شد.", false);
          pollJobStatus();
        } else {
          persistActiveJob();
        }
      }
    } catch (_e) {}
  }

  async function cancelActiveJob() {
    if (!state.activeJobId) return;
    try {
      await sendIpc("JOB_CANCEL", { jobId: state.activeJobId });
      showNotice("درخواست لغو پردازش ارسال شد.", false);
    } catch (err) {
      showNotice("خطا در لغو: " + err.message, true);
    }
  }

  async function handleExport(format) {
    if (state.segments.length === 0) {
      $("exportPreview").textContent = "متنی برای خروجی وجود ندارد.";
      return;
    }
    try {
      var res = await sendIpc("CAPABILITY_EXECUTE", {
        action: "EXPORT_TRANSCRIPT",
        format: format,
        segments: state.segments,
        timelineOffsetSec: Number($("timelineOffsetInput").value) || 0,
      });
      var content = res.exported.content;
      $("exportPreview").textContent = content;

      var blob = new Blob([content], { type: res.exported.mimeType });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "avapardaz-transcript." + res.exported.fileExtension;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      $("exportPreview").textContent = "خطا در خروجی: " + err.message;
    }
  }

  function wireUi() {
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (b) {
          b.classList.remove("active");
          b.setAttribute("aria-selected", "false");
        });
        document.querySelectorAll(".panel").forEach(function (p) {
          p.classList.remove("active");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-selected", "true");
        $("tab-" + btn.dataset.tab).classList.add("active");
      });
    });

    $("btnSyncAudition").addEventListener("click", syncAuditionDocument);
    $("btnStartJob").addEventListener("click", startTranscription);
    $("btnCancelJob").addEventListener("click", cancelActiveJob);
    $("searchInput").addEventListener("input", renderSegments);

    $("localFileInput").addEventListener("change", function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      state.selectedFileName = file.name;
      $("auditionDocInfo").textContent = file.name + " (" + (file.size / 1024 / 1024).toFixed(2) + " MB)";
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || "");
        var commaIdx = result.indexOf(",");
        state.selectedFileBase64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      };
      reader.readAsDataURL(file);
    });

    $("btnUndo").addEventListener("click", function () {
      if (state.undoStack.length === 0) return;
      state.redoStack.push(JSON.stringify(state.segments));
      state.segments = JSON.parse(state.undoStack.pop());
      updateUndoButtons();
      saveDraftLocal();
      renderSegments();
    });

    $("btnRedo").addEventListener("click", function () {
      if (state.redoStack.length === 0) return;
      state.undoStack.push(JSON.stringify(state.segments));
      state.segments = JSON.parse(state.redoStack.pop());
      updateUndoButtons();
      saveDraftLocal();
      renderSegments();
    });

    $("btnReplaceAll").addEventListener("click", function () {
      var findStr = $("searchInput").value;
      var repStr = $("replaceInput").value;
      if (!findStr) return;
      pushUndoSnapshot();
      state.segments.forEach(function (s) {
        s.text = (s.text || "").split(findStr).join(repStr);
      });
      saveDraftLocal();
      renderSegments();
    });

    $("btnCopyAll").addEventListener("click", function () {
      var full = state.segments.map(function (s) { return s.text; }).join("\n");
      if (navigator.clipboard) navigator.clipboard.writeText(full).catch(function () {});
    });

    document.querySelectorAll("[data-export]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        handleExport(btn.dataset.export);
      });
    });

    $("btnReconnect").addEventListener("click", function () {
      state.companionUrl = $("companionUrlInput").value.trim().replace(/\/+$/, "");
      state.sessionId = null;
      state.sessionToken = null;
      refreshHealth();
    });

    $("btnUnloadModel").addEventListener("click", async function () {
      try {
        await sendIpc("CAPABILITY_EXECUTE", { action: "MODEL_UNLOAD" });
        refreshHealth();
      } catch (_e) {}
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireUi();
    restoreDraftLocal();
    refreshHealth().then(tryReconnectPersistedJob);
  });
})();
