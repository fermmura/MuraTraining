// PREENCHER SEMANA ATUAL — devolve pra ficha do aluno (os campos "feito" e
// "kg" que ele vê na tela) o que ele anotou na semana, a partir do histórico
// do app ou de uma planilha exportada pelo dados.html. Só preenche campo vazio:
// nunca troca um valor que já está lá.
//
// Funções puras (sem Firebase nem DOM) pra poderem ser testadas fora do navegador.

function weekKeyOfDate(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  const y = monday.getFullYear(), m = String(monday.getMonth() + 1).padStart(2, "0"), dd = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// compara nomes sem ligar pra maiúscula, acento ou espaço sobrando
function normText(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

function slotKey(dayTitle, exName, setIndex) {
  return `${normText(dayTitle)}|${normText(exName)}|${setIndex}`;
}

// ---------------------------------------------------------------------
// leitura da planilha
// ---------------------------------------------------------------------

// célula do Excel -> "AAAA-MM-DD". Datas gravadas pelo dados.html voltam
// como Date (em UTC); também aceita texto "dd/mm/aaaa".
function cellToDateKey(v) {
  if (v && typeof v === "object" && !(v instanceof Date) && "result" in v) v = v.result;
  if (v instanceof Date && !isNaN(v)) {
    // a data foi gravada à meia-noite local; em UTC ela cai no mesmo dia
    // (Brasil está atrás de UTC), então o dia certo é o do UTC
    const y = v.getUTCFullYear(), m = String(v.getUTCMonth() + 1).padStart(2, "0"), d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

function cellToText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("result" in v) return cellToText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
  }
  if (typeof v === "number") return String(v);
  return String(v).trim();
}

// linhas da aba de histórico (a primeira é o cabeçalho) -> registros no
// mesmo formato do history do app. Acha as colunas pelo nome do cabeçalho,
// então funciona mesmo se a ordem das colunas mudar.
function entriesFromSheetRows(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => normText(cellToText(h)));
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const iDate = col("data");
  const iDay = col("treino");
  const iEx = col("exercicio");
  const iSet = col("serie");
  const iGoal = col("meta");
  const iDone = col("feito");
  const iLoad = col("carga (kg)", "carga", "kg");
  if (iDate < 0 || iDay < 0 || iEx < 0 || iSet < 0) return [];

  const entries = [];
  for (const r of rows.slice(1)) {
    const dateKey = cellToDateKey(r[iDate]);
    const setNumber = parseInt(cellToText(r[iSet]), 10);
    if (!dateKey || !Number.isFinite(setNumber)) continue;
    entries.push({
      dateKey,
      weekKey: weekKeyOfDate(dateKey),
      dayTitle: cellToText(r[iDay]),
      exName: cellToText(r[iEx]),
      setIndex: setNumber - 1,
      repsGoal: iGoal >= 0 ? cellToText(r[iGoal]) : "",
      repsDone: iDone >= 0 ? cellToText(r[iDone]) : "",
      load: iLoad >= 0 ? cellToText(r[iLoad]) : "",
    });
  }
  return entries;
}

// nome do arquivo "Fulano — MuraTraining.xlsx" -> "Fulano"
function studentNameFromFilename(filename) {
  return String(filename || "").replace(/\.xlsx$/i, "").split(" — ")[0].trim();
}

// acha o aluno pelo nome. Nome de aba é cortado em 28 letras, então aceita
// começo igual quando não tem nome exato.
function matchClientByName(clients, name) {
  const n = normText(name).replace(/\s*\(\d+\)$/, "");
  if (!n) return null;
  const exact = clients.filter((c) => normText(c.name) === n);
  if (exact.length === 1) return exact[0];
  const prefix = clients.filter((c) => normText(c.name).startsWith(n));
  return prefix.length === 1 ? prefix[0] : null;
}

// ---------------------------------------------------------------------
// preenchimento
// ---------------------------------------------------------------------

// semana que a ficha do aluno está mostrando agora
function activeWeekKeyOf(client, todayKey) {
  return client.activeWeekKey || weekKeyOfDate(todayKey);
}

// entries: registros (do history ou da planilha) — só os da semana weekKey
// são usados. Casa cada série da ficha primeiro pelo id da série (só o
// history tem) e, se não achar, por treino + exercício + número da série.
// Se a série aparece em mais de um dia da semana, vale a anotação mais recente.
function computeWeekFill(client, entries, weekKey, { addToHistory = false } = {}) {
  const inWeek = entries.filter((e) => e.weekKey === weekKey && (hasValue(e.repsDone) || hasValue(e.load)));
  const latest = (a, b) => (!a || (b.dateKey || "") >= (a.dateKey || "") ? b : a);

  const bySetId = new Map();
  const bySlot = new Map();
  for (const e of inWeek) {
    if (e.setId) bySetId.set(e.setId, latest(bySetId.get(e.setId), e));
    const k = slotKey(e.dayTitle, e.exName, e.setIndex);
    bySlot.set(k, latest(bySlot.get(k), e));
  }

  const fills = [];
  const history = client.history || [];
  const newHistory = [];
  const nextDays = (client.days || []).map((day) => ({
    ...day,
    exercises: (day.exercises || []).map((ex) => ({
      ...ex,
      sets: (ex.sets || []).map((s, i) => {
        const src = bySetId.get(s.id) || bySlot.get(slotKey(day.title, ex.name, i));
        if (!src) return s;
        const patch = {};
        if (!hasValue(s.repsDone) && hasValue(src.repsDone)) patch.repsDone = String(src.repsDone);
        if (!hasValue(s.load) && hasValue(src.load)) patch.load = String(src.load);
        if (!Object.keys(patch).length) return s;
        fills.push({ dayTitle: day.title || "", exName: ex.name || "", setIndex: i, dateKey: src.dateKey, ...patch });

        // a planilha pode ter registros que o histórico do app perdeu:
        // devolve pro histórico também, pra aparecer no progresso
        if (addToHistory) {
          const already = history.some((h) =>
            h.dateKey === src.dateKey &&
            (h.setId === s.id || slotKey(h.dayTitle, h.exName, h.setIndex) === slotKey(day.title, ex.name, i)));
          if (!already) {
            newHistory.push({
              dateKey: src.dateKey,
              weekKey: weekKeyOfDate(src.dateKey),
              dayId: day.id, dayTitle: day.title || "", exId: ex.id, exName: ex.name || "", setId: s.id, setIndex: i,
              repsGoal: s.repsGoal || src.repsGoal || "",
              repsDone: String(src.repsDone || ""),
              load: String(src.load || ""),
            });
          }
        }
        return { ...s, ...patch };
      }),
    })),
  }));

  return { nextDays, fills, newHistory };
}

if (typeof module !== "undefined") {
  module.exports = {
    weekKeyOfDate, normText, cellToDateKey, entriesFromSheetRows, studentNameFromFilename,
    matchClientByName, activeWeekKeyOf, computeWeekFill,
  };
}
