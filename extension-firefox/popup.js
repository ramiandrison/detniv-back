(function () {
  "use strict";

  const DEFAULTS = { format: "jpeg", quality: 0.92 };

  const formatRadios = document.querySelectorAll('input[name="format"]');
  const qualitySlider = document.getElementById("quality");
  const qualityValue = document.getElementById("quality-value");
  const qualityGroup = document.getElementById("quality-group");
  const statusEl = document.getElementById("status");

  /* ── Helpers ── */

  function currentSettings() {
    const format =
      document.querySelector('input[name="format"]:checked')?.value ||
      DEFAULTS.format;
    const quality = parseInt(qualitySlider.value, 10) / 100;
    return { format, quality };
  }

  function applyToUI(settings) {
    const fmt = settings.format || DEFAULTS.format;
    const radio = document.querySelector(
      `input[name="format"][value="${fmt}"]`
    );
    if (radio) radio.checked = true;

    const q = Math.round((settings.quality ?? DEFAULTS.quality) * 100);
    qualitySlider.value = q;
    qualityValue.textContent = q + "%";

    toggleQualityVisibility(fmt);
  }

  function toggleQualityVisibility(format) {
    qualityGroup.style.display = format === "png" ? "none" : "";
  }

  function flashStatus() {
    statusEl.textContent = "Paramètres enregistrés ✓";
    statusEl.classList.add("saved");
    setTimeout(() => {
      statusEl.textContent = "Paramètres enregistrés";
      statusEl.classList.remove("saved");
    }, 1500);
  }

  async function save() {
    const s = currentSettings();
    try {
      await browser.storage.local.set({ settings: s });
      flashStatus();
    } catch (err) {
      console.error("[HEIC popup] Save error:", err);
    }
  }

  /* ── Init ── */

  async function init() {
    try {
      const result = await browser.storage.local.get("settings");
      applyToUI({ ...DEFAULTS, ...(result.settings || {}) });
    } catch (_) {
      applyToUI(DEFAULTS);
    }

    for (const radio of formatRadios) {
      radio.addEventListener("change", () => {
        toggleQualityVisibility(radio.value);
        save();
      });
    }

    qualitySlider.addEventListener("input", () => {
      qualityValue.textContent = qualitySlider.value + "%";
    });

    qualitySlider.addEventListener("change", save);
  }

  init();
})();
