(() => {
    const ids = ["matchup", "map", "synergy", "counter", "statistics"];
    const weights = [30, 20, 25, 10, 15];
    const defaults = [6, 7, 5.5, 4, 5.5];
    const presets = {"kings-reinhardt":[2.6,5,8.1,5,5.2],"kings-sigma":[2.3,5,5.5,5,5.1],"circuit-2":[5.6,4.6,5.7,5,4.3],"circuit-3":[5.6,5.6,5.7,5,4.3]};
    const presetButtons = [...document.querySelectorAll("[data-score-preset]")];
    const selectPreset = key => presetButtons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.scorePreset === key)));
    const fields = ids.map(id => document.getElementById(`v-${id}`));
    const included = document.getElementById("include-statistics");
    const output = document.getElementById("calc-result");
    function update() {
      const values = fields.map(field => field.value === "" ? NaN : Number(field.value));
      fields[4].disabled = !included.checked;
      const active = included.checked ? values : values.slice(0, 4);
      if (active.some(value => !Number.isFinite(value))) { output.textContent = "사용하는 항목에 숫자를 입력해 주세요."; return; }
      const normalized = active.map(value => Math.round(Math.max(0, Math.min(10, value)) * 10) / 10);
      const denominator = included.checked ? 100 : 85;
      const raw = normalized.reduce((sum, value, index) => sum + value * weights[index], 0) / denominator;
      const score = Math.round(Math.max(1, Math.min(9, 5 + (raw - 5) * 2.5)) * 10) / 10;
      output.replaceChildren(document.createTextNode(`원점수 ${raw.toFixed(6).replace(/\.?0+$/, "")} · 분모 ${denominator} · 공개 점수 `));
      const strong = document.createElement("strong"); strong.textContent = score.toFixed(1); output.append(strong);
    }
    fields.forEach(field => field.addEventListener("input", () => { selectPreset(null); update(); }));
    presetButtons.forEach(button => button.addEventListener("click", () => { const values = presets[button.dataset.scorePreset]; if (!values) return; fields.forEach((field, index) => { field.value = String(values[index]); }); included.checked = true; selectPreset(button.dataset.scorePreset); update(); }));
    included.addEventListener("change", () => { selectPreset(null); update(); });
    document.getElementById("reset-calculator").addEventListener("click", () => { fields.forEach((field, index) => { field.value = String(defaults[index]); }); included.checked = true; selectPreset(null); update(); });
    update();
  })();
