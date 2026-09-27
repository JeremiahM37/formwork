/**
 * formwork — first-run setup.
 *
 * Builds the same storage keys the settings page writes, from questions rather
 * than from a JSON textarea. The profile shape produced here is exactly what
 * `tools/parse_resume.py` emits, so a user can start with the wizard and later
 * replace the profile wholesale without anything downstream noticing.
 *
 * Partial answers are the normal case, not an error: an empty field is simply
 * absent from the profile, and the fill panel reports what it could not answer.
 */
(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const steps = Array.from(document.querySelectorAll(".step"));
  const PROVIDER_FIELDS = {
    homelab: ["baseUrl"],
    ollama: ["baseUrl", "model"],
    "openai-compatible": ["baseUrl", "model", "apiKey"],
    anthropic: ["model", "apiKey"],
  };

  const store = await chrome.storage.local.get([
    "settings",
    "profile",
    "about",
    "documents",
    "credentials",
  ]);
  const settings = store.settings || {};
  const documents = store.documents || {};
  let index = 0;

  /* ----------------------------------------------------------- prefill */

  // Re-running setup should show what is already stored, not a blank form.
  const profile = store.profile || {};
  const value = (id, v) => {
    if (v !== undefined && v !== null && v !== "") $(id).value = v;
  };
  value("first_name", profile.identity?.first_name);
  value("last_name", profile.identity?.last_name);
  value("email", profile.identity?.email);
  value("phone", profile.identity?.phone);
  value("phone_country", profile.identity?.phone_country);
  value("phone_type", profile.identity?.phone_type);
  value("language", profile.identity?.language);
  for (const part of ["street", "city", "state", "postal_code", "country"]) {
    value(part, profile.identity?.location?.[part]);
  }
  for (const link of ["linkedin", "github", "website"]) value(link, profile.links?.[link]);
  const yesNo = (v) => (v === true ? "Yes" : v === false ? "No" : undefined);
  value("authorized", yesNo(profile.work_authorization?.authorized_to_work_us));
  value("sponsorship", yesNo(profile.work_authorization?.requires_sponsorship_now));
  value("relocate", yesNo(profile.identity?.willing_to_relocate));
  value("start", profile.preferences?.earliest_start_date);
  value("preferred_contact_method", profile.preferences?.preferred_contact_method);
  for (const [id, path] of [
    ["gender", "gender"],
    ["hispanic", "hispanic_latino"],
    ["race", "race_ethnicity"],
    ["veteran", "veteran_status"],
    ["disability", "disability_status"],
  ]) {
    value(id, profile.demographics?.[path]);
  }
  value("about", store.about);
  value("cred-email", store.credentials?.email);
  value("cred-password", store.credentials?.password);
  if (settings.provider) $("provider").value = settings.provider;
  for (const [provider, fields] of Object.entries(PROVIDER_FIELDS)) {
    for (const field of fields) {
      const input = $(`${provider}-${field}`);
      if (input && settings[provider]?.[field]) input.value = settings[provider][field];
    }
  }
  const showDoc = (key, id) => {
    if (documents[key]) $(id).textContent = `— stored: ${documents[key].name}`;
  };
  showDoc("resume", "resumeCurrent");
  showDoc("cover_letter", "coverCurrent");

  /* ------------------------------------------------------------ steps */

  const dots = $("dots");
  dots.innerHTML = steps.map(() => "<i></i>").join("");

  function render() {
    steps.forEach((s, i) => s.classList.toggle("active", i === index));
    dots.querySelectorAll("i").forEach((d, i) => d.classList.toggle("done", i <= index));
    $("back").disabled = index === 0;
    const last = index === steps.length - 1;
    $("next").textContent = last ? "Finish" : "Continue";
    // The welcome and final screens have nothing to skip past.
    $("skip").style.visibility = index === 0 || last ? "hidden" : "visible";
    if (last) summarize();
    window.scrollTo(0, 0);
  }

  const go = (delta) => {
    index = Math.max(0, Math.min(steps.length - 1, index + delta));
    render();
  };

  $("back").addEventListener("click", () => go(-1));
  $("skip").addEventListener("click", () => go(1));
  $("next").addEventListener("click", async () => {
    await save();
    if (index === steps.length - 1) {
      await chrome.storage.local.set({ setupComplete: true });
      window.close();
      return;
    }
    go(1);
  });

  /* --------------------------------------------------------- provider */

  function syncProvider() {
    const chosen = $("provider").value;
    document
      .querySelectorAll(".provider")
      .forEach((el) => el.classList.toggle("active", el.dataset.provider === chosen));
  }
  $("provider").addEventListener("change", syncProvider);
  syncProvider();

  /* -------------------------------------------------------- documents */

  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  for (const [inputId, key, labelId] of [
    ["resumeFile", "resume", "resumeCurrent"],
    ["coverFile", "cover_letter", "coverCurrent"],
  ]) {
    $(inputId).addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      documents[key] = { name: file.name, type: file.type, dataUrl: await readAsDataUrl(file) };
      $(labelId).textContent = `— stored: ${file.name}`;
      await chrome.storage.local.set({ documents });
    });
  }

  /* ------------------------------------------------------------- save */

  const text = (id) => $(id).value.trim();

  /** Drop empty keys so a skipped step leaves no misleading blank behind. */
  function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === "" || v === undefined || v === null) continue;
      if (typeof v === "object" && !Array.isArray(v)) {
        const inner = compact(v);
        if (Object.keys(inner).length) out[k] = inner;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function buildProfile() {
    const first = text("first_name");
    const last = text("last_name");
    // Merge over any existing profile so a résumé-derived history survives a
    // re-run of setup, which only ever asks about the parts it shows.
    return {
      ...profile,
      identity: {
        ...profile.identity,
        phone_country: text("phone_country") || undefined,
        ...compact({
          first_name: first,
          last_name: last,
          full_name: [first, last].filter(Boolean).join(" "),
          email: text("email"),
          phone: text("phone"),
          phone_type: $("phone_type").value,
          language: text("language"),
          willing_to_relocate: $("relocate").value === "Yes",
          location: compact({
            street: text("street"),
            city: text("city"),
            state: text("state"),
            postal_code: text("postal_code"),
            country: text("country"),
          }),
        }),
      },
      links: { ...profile.links, ...compact({ linkedin: text("linkedin"), github: text("github"), website: text("website") }) },
      // These key names are the ones `tools/parse_resume.py` emits and the
      // validator pins against. A wizard-built profile has to be the same
      // shape as a résumé-built one, or it silently answers nothing here —
      // and work authorisation is precisely where a blank is dangerous.
      work_authorization: {
        ...profile.work_authorization,
        authorized_to_work_us: $("authorized").value === "Yes",
        requires_sponsorship_now: $("sponsorship").value === "Yes",
        requires_sponsorship_future: $("sponsorship").value === "Yes",
      },
      preferences: {
        ...profile.preferences,
        preferred_contact_method: text("preferred_contact_method") || undefined,
        ...compact({ earliest_start_date: text("start") }),
      },
      demographics: {
        ...profile.demographics,
        gender: $("gender").value,
        hispanic_latino: $("hispanic").value,
        race_ethnicity: $("race").value,
        veteran_status: $("veteran").value,
        disability_status: $("disability").value,
      },
    };
  }

  async function save() {
    const chosen = $("provider").value;
    const nextSettings = { ...settings, provider: chosen };
    for (const [provider, fields] of Object.entries(PROVIDER_FIELDS)) {
      const current = { ...(settings[provider] || {}) };
      for (const field of fields) {
        const input = $(`${provider}-${field}`);
        if (input && input.value.trim()) current[field] = input.value.trim();
      }
      nextSettings[provider] = current;
    }

    await chrome.storage.local.set({
      profile: buildProfile(),
      about: text("about"),
      documents,
      credentials: {
        ...(store.credentials || {}),
        email: text("cred-email"),
        password: $("cred-password").value,
      },
      settings: nextSettings,
    });
  }

  /** What the user actually ends up with, stated plainly rather than implied. */
  function summarize() {
    const built = buildProfile();
    const bits = [];
    const name = built.identity?.full_name;
    bits.push(name ? `Profile for ${name}` : "Profile saved (no name given)");
    if (built.identity?.location?.city) bits.push(built.identity.location.city);
    bits.push(documents.resume ? `résumé: ${documents.resume.name}` : "no résumé stored");
    bits.push(text("cred-email") ? "account credentials set" : "no account credentials");
    bits.push(
      $(`${$("provider").value}-apiKey`)?.value || $("provider").value === "ollama"
        ? `drafting via ${$("provider").value}`
        : "no drafting model configured — factual fields still fill"
    );
    $("summary").textContent = bits.join(" · ") + ".";
  }

  render();
})();
