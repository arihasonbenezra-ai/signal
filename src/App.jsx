import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

const T = {
  navy:"#1A0066",navy2:"#250088",teal:"#4ECDC4",teal2:"#38B8AF",
  tealLight:"#E8F8F7",tealMid:"#A8E6E3",bg:"#F6F7F5",card:"#FFFFFF",
  surface:"#EBF0EB",border:"#DDE3DD",border2:"#C8D0C8",text:"#3D4042",
  muted:"#6B7280",dim:"#9CA3AF",green:"#059669",greenLight:"#ECFDF5",
  amber:"#D97706",amberLight:"#FFFBEB",red:"#DC2626",redLight:"#FEF2F2",
  chart:["#4ECDC4","#1A0066","#D97706","#059669","#C77DFF","#FF85A1","#F97316","#06B6D4"],
  pipeline:["#C8F0ED","#90DDD8","#4ECDC4","#38B8AF","#1E8A85","#0F5F5A","#1A0066"],
  /** Layered shadows (navy-tinted) for depth without heavy borders */
  elev:{sm:"0 1px 2px rgba(61,64,66,0.05), 0 4px 14px -2px rgba(26,0,102,0.08)",md:"0 2px 4px rgba(61,64,66,0.04), 0 10px 28px -4px rgba(26,0,102,0.11)",lg:"0 4px 8px rgba(26,0,102,0.06), 0 20px 48px -12px rgba(26,0,102,0.16)",header:"0 1px 0 rgba(255,255,255,0.85) inset, 0 6px 24px -6px rgba(26,0,102,0.12), 0 1px 3px rgba(0,0,0,0.04)",inset:"inset 0 1px 0 rgba(255,255,255,0.75)"},
};
const pageBg = `radial-gradient(ellipse 120% 70% at 50% -8%, rgba(78,205,196,0.14), transparent 52%), radial-gradient(ellipse 85% 55% at 100% 0%, rgba(26,0,102,0.06), transparent 50%), radial-gradient(ellipse 70% 40% at 0% 100%, rgba(78,205,196,0.06), transparent 45%), ${T.bg}`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const STATUS_MAP = {"filled":"Filled","on hold":"On Hold"};
function normalizeStatus(v) {
  const s = String(v).toLowerCase().trim();
  if (STATUS_MAP[s]) return STATUS_MAP[s];
  if (s.includes("not act")) return "Open, not actively recruiting";
  if (s.includes("open") && s.includes("act")) return "Open, actively recruiting";
  return String(v).trim();
}
const CANONICAL_STATUSES = ["Open, actively recruiting","Open, not actively recruiting","On Hold","Filled"];
function isStatusCol(h) { return /update|status|state|disposition/i.test(h); }
function isRecruiterCol(h) { return /^recruiter$|primary.rec|sourcer|ta.partner|hiring.partner/i.test(h); }
function isDeptCol(h) { return /department|dept|division|department.head|business.unit/i.test(h); }
function isRoleCol(h) { return /job.req|requisition|position|role|title/i.test(h); }
function isNumericCol(vals) { return vals.length > 0 && vals.filter(v=>typeof v==="number").length/vals.length > 0.75; }
function isTotalCol(h) { return /total|sum|grand/i.test(h); }
/** Match AI/spreadsheet column names to actual row keys (spacing, casing, "Primary …"). */
function rowValueForColumn(row, col, headerList) {
  if (!row || !col) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, col)) return row[col];
  const lc = (s) => String(s).trim().toLowerCase();
  const hit = headerList.find((h) => h && lc(h) === lc(col));
  if (hit && row[hit] !== undefined) return row[hit];
  const sub = headerList.find((h) => h && (lc(h).includes(lc(col)) || lc(col).includes(lc(h))));
  if (sub && row[sub] !== undefined) return row[sub];
  return undefined;
}
function shortStage(s) {
  return s.replace(/Recruiter Screen/i,"Screen").replace(/Hiring Manager Screen/i,"HM Screen")
    .replace(/Virtual Interview/i,"Virtual").replace(/Onsite Interview/i,"Onsite")
    .replace(/Final Round/i,"Final").replace(/Interview/i,"Int.");
}

function uniqueVals(rows, col) {
  if (isStatusCol(col)) {
    const found = new Set(rows.map(r=>normalizeStatus(r[col]??"")));
    return CANONICAL_STATUSES.filter(s=>found.has(s));
  }
  return [...new Set(rows.map(r=>String(r[col]??"")))].filter(v=>v&&v!=="undefined"&&v!=="").sort();
}

function cleanData(headers, rows) {
  const vh = headers.filter(h => h && !h.match(/^Unnamed[:\s_]/i) && h.trim() && !h.match(/^Column\d+$/i));
  const vr = rows.filter(row => {
    const vals = Object.values(row);
    if (vals.every(v=>v===""||v==null)) return false;
    const first = String(Object.values(row)[0]??"").toLowerCase().trim();
    if (/^(grand\s+)?total$|^subtotal$|^sum$|^average$/.test(first)) return false;
    return true;
  }).map(row => {
    const out = {};
    vh.forEach(h => {
      let v = row[h];
      if (typeof v === "string") {
        const c = v.trim();
        const n = parseFloat(c.replace(/[$,%\s]/g,""));
        if (!isNaN(n) && c !== "") { out[h]=n; return; }
        out[h] = c;
      } else out[h] = v;
    });
    return out;
  });
  // Forward-fill blank categorical cells (Workday groups rows this way)
  const lastSeen = {};
  vr.forEach(row => {
    vh.forEach(h => {
      const v = row[h];
      const isEmpty = v===""||v==null||v===undefined;
      if (isEmpty) { if (lastSeen[h]!==undefined) row[h]=lastSeen[h]; }
      else if (typeof v==="string"&&v.trim()!=="") lastSeen[h]=v;
      else if (typeof v!=="number") lastSeen[h]=v;
    });
  });
  return { headers: vh, rows: vr };
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("Need header + data rows");
  function pr(line) {
    const cells=[]; let cell=""; let inQ=false;
    for (let i=0;i<line.length;i++) {
      const c=line[i];
      if(c==='"'){if(inQ&&line[i+1]==='"'){cell+='"';i++;}else inQ=!inQ;}
      else if(c===','&&!inQ){cells.push(cell.trim());cell="";}
      else cell+=c;
    }
    cells.push(cell.trim()); return cells;
  }
  const rh = pr(lines[0]).map(h=>h.replace(/^["']|["']$/g,"").trim());
  const rows = lines.slice(1).filter(l=>l.trim()).map(line=>{
    const vals=pr(line); const obj={};
    rh.forEach((h,i)=>{ const raw=(vals[i]??"").replace(/^["']|["']$/g,"").trim(); const n=parseFloat(raw.replace(/[$,%\s]/g,"")); obj[h]=!isNaN(n)&&raw!==""?n:raw; });
    return obj;
  });
  return cleanData(rh, rows);
}

function parseTSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const rh = lines[0].split("\t").map(h=>h.trim());
  const rows = lines.slice(1).filter(l=>l.trim()).map(line=>{
    const vals=line.split("\t"); const obj={};
    rh.forEach((h,i)=>{ const raw=(vals[i]??"").trim(); const n=parseFloat(raw.replace(/[$,%\s]/g,"")); obj[h]=!isNaN(n)&&raw!==""?n:raw; });
    return obj;
  });
  return cleanData(rh, rows);
}

function toCSVUrl(url) {
  const m=url.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if(!m) return null;
  const gid=(url.match(/gid=(\d+)/)||[])[1]||"0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

/** Avoids `Unexpected end of JSON input` when the body is empty (wrong route, HTML fallback, proxy off). */
async function readJsonResponse(res) {
  const text = await res.text();
  if (!text || !text.trim()) {
    const hint = res.status === 404
      ? " /api/chat is missing — in dev, set ANTHROPIC_API_KEY in .env and restart Vite (proxy forwards to Anthropic)."
      : "";
    throw new Error(`Empty response (HTTP ${res.status}).${hint}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from server (${res.status}): ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);
  }
}

async function exportPDF(analysis, summaryCards, fileName, isPipelineReport, pipelineNumericCols, activeFilters, filteredCount, totalCount, filteredRows) {
  const doc = window._jsPDF && new window._jsPDF.jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
  if (!doc) { alert("PDF library still loading — try again."); return; }
  const navy=[26,0,102], teal=[78,205,196], pageW=210, margin=20;
  doc.setFillColor(...navy); doc.rect(0,0,pageW,28,"F");
  doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(16);
  doc.text("Signal.", margin, 17);
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(200,220,220);
  doc.text("Talent data, clearly.", margin, 23);
  doc.text(new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}), pageW-margin, 17, {align:"right"});
  let y = 40;
  doc.setTextColor(...navy); doc.setFont("helvetica","bold"); doc.setFontSize(18);
  doc.text(analysis.title||fileName, margin, y); y+=8;
  doc.setDrawColor(...teal); doc.setLineWidth(0.8); doc.line(margin,y,pageW-margin,y); y+=5;

  // Active filters banner
  const filterEntries = activeFilters ? Object.entries(activeFilters).filter(([,v])=>v) : [];
  if (filterEntries.length > 0) {
    doc.setFillColor(232,248,247);
    doc.roundedRect(margin, y, pageW-margin*2, 10, 1.5, 1.5, "F");
    doc.setTextColor(56,184,175);
    doc.setFont("helvetica","bold"); doc.setFontSize(7.5);
    doc.text("FILTERED VIEW", margin+4, y+6.5);
    doc.setFont("helvetica","normal");
    const filterText = filterEntries.map(([k,v])=>`${k.replace(/Primary /i,"")}: ${v}`).join("  ·  ");
    doc.setTextColor(61,64,66);
    doc.text(filterText, margin+32, y+6.5);
    if (filteredCount !== totalCount) {
      doc.setTextColor(107,128,112);
      doc.text(`${filteredCount} of ${totalCount} rows`, pageW-margin, y+6.5, {align:"right"});
    }
    y+=14;
  } else { y+=3; }
    let briefText = analysis.narrative || "";
  let insightsList = Array.isArray(analysis.insights) ? analysis.insights : [];

  if (filterEntries.length > 0 && filteredRows && filteredRows.length > 0) {
    try {
      const apiRes = await fetch("/api/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 400,
          messages: [{
            role: "user",
            content: "Talent analytics expert. Write a 2-sentence summary and 3 bullet insights ONLY about these " + filteredRows.length + " rows. Active filter: " + filterEntries.map(([k,v]) => k + ": " + v).join(", ") + ". Data: " + JSON.stringify(filteredRows.slice(0, 40)) + ". Return JSON only: {\"brief\":\"...\",\"insights\":[\"...\",\"...\",\"...\"]}"
          }]
        })
      });
      const apiData = await readJsonResponse(apiRes);
      if (apiData.error) throw new Error(apiData.error.message || "API error");
      const parsed = JSON.parse(apiData.content[0].text.replace(/```json\n?|```/g, "").trim());
      briefText = parsed.brief;
      insightsList = parsed.insights;
    } catch(e) { console.error("PDF brief generation failed:", e); }
  }

  if (briefText) {
    doc.setFillColor(232,248,247); doc.roundedRect(margin,y,pageW-margin*2,30,2,2,"F");
    doc.setFillColor(...teal); doc.roundedRect(margin,y,3,30,1,1,"F");
    doc.setTextColor(...navy); doc.setFont("helvetica","bold"); doc.setFontSize(8);
    doc.text("THE BRIEF", margin+6, y+6);
    doc.setTextColor(61,64,66); doc.setFont("helvetica","normal"); doc.setFontSize(9);
    doc.text(doc.splitTextToSize(briefText, pageW-margin*2-12).slice(0,3), margin+6, y+13); y+=38;
  }
  if (insightsList.length) {
    doc.setTextColor(...navy); doc.setFont("helvetica","bold"); doc.setFontSize(10);
    doc.text("KEY SIGNALS", margin, y); y+=5;
    doc.setDrawColor(...navy); doc.setLineWidth(0.3); doc.line(margin,y,pageW-margin,y); y+=6;
    insightsList.forEach((ins,i)=>{
      const insLines=doc.splitTextToSize(ins,pageW-margin*2-14).slice(0,2);
      const insH=insLines.length>1?16:10;
      doc.setFillColor(i===0?232:235,i===0?248:240,i===0?247:235);
      doc.roundedRect(margin,y,pageW-margin*2,insH,1.5,1.5,"F");
      doc.setTextColor(i===0?56:107,i===0?184:128,i===0?175:112);
      doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.text(String(i+1),margin+4,y+6.5);
      doc.setTextColor(61,64,66); doc.setFont("helvetica","normal"); doc.setFontSize(8.5);
      doc.text(insLines,margin+10,y+6.5); y+=insH+3;
    }); y+=4;
  }
  if (summaryCards?.length) {
    doc.setTextColor(...navy); doc.setFont("helvetica","bold"); doc.setFontSize(10);
    doc.text("SUMMARY", margin, y); y+=5;
    doc.setDrawColor(...navy); doc.setLineWidth(0.3); doc.line(margin,y,pageW-margin,y); y+=6;
    summaryCards.forEach(card=>{
      if(y>260){doc.addPage();y=20;}
      doc.setFillColor(245,246,245); doc.roundedRect(margin,y,pageW-margin*2,14,2,2,"F");
      const label = isPipelineReport ? card.label : card.recruiter;
      const sub = isPipelineReport ? `${card.roleCount} roles · ${card.total} candidates` : `${card.total} reqs`;
      doc.setTextColor(...navy); doc.setFont("helvetica","bold"); doc.setFontSize(9);
      doc.text(label, margin+4, y+5.5);
      doc.setTextColor(107,128,112); doc.setFont("helvetica","normal"); doc.setFontSize(8);
      doc.text(sub, margin+4, y+10.5); y+=17;
    });
  }
  doc.setFillColor(...navy); doc.rect(0,285,pageW,12,"F");
  doc.setTextColor(200,220,220); doc.setFont("helvetica","normal"); doc.setFontSize(7);
  doc.text("Generated by Signal · aribenezra.com", margin, 292);
  doc.text(fileName, pageW-margin, 292, {align:"right"});
  doc.save(`signal-${fileName.replace(/\.[^.]+$/,"")}-report.pdf`);
}

export default function Signal() {
  const [step, setStep] = useState("upload");
  const [tab, setTab] = useState("file");
  const [headers, setHeaders] = useState([]);
  const [data, setData] = useState([]);
  const [fileName, setFileName] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [gsUrl, setGsUrl] = useState("");
  const [pasteVal, setPasteVal] = useState("");
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [procMsg, setProcMsg] = useState("Reading your data...");
  const [activeFilters, setActiveFilters] = useState({});
  const [drillDown, setDrillDown] = useState(null);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [signalsOpen, setSignalsOpen] = useState(true);
  const [viewMode, setViewMode] = useState("chart");

  const fileRef = useRef();
  const chatEndRef = useRef();
  const xlsxRef = useRef(null);
  const procInterval = useRef(null);

  useEffect(() => {
    const s=document.createElement("script");
    s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload=()=>{xlsxRef.current=window.XLSX;}; document.head.appendChild(s);
    const p=document.createElement("script");
    p.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    p.onload=()=>{window._jsPDF=window.jspdf;}; document.head.appendChild(p);
  },[]);
  useEffect(()=>{chatEndRef.current?.scrollIntoView({behavior:"smooth"});},[chatMsgs]);

  // ─── DERIVED: report type detection ──────────────────────────────────────
  const pipelineNumericCols = useMemo(()=>{
    if (!analysis||!headers.length) return [];
    return headers.filter(h=>{
      if (isTotalCol(h)) return false;
      const vals = data.map(r=>r[h]).filter(v=>v!==null&&v!==undefined&&v!=="");
      return isNumericCol(vals);
    });
  },[analysis, headers, data]);

  const isPipelineReport = useMemo(()=> pipelineNumericCols.length >= 3, [pipelineNumericCols]);

  // ─── DERIVED: filter columns ──────────────────────────────────────────────
  const filterCols = useMemo(()=>{
    if (!analysis) return [];
    const catCols = headers.filter(h=>{
      const vals = data.map(r=>r[h]).filter(v=>v!==null&&v!==undefined&&v!=="");
      if (!vals.length) return false;
      if (isNumericCol(vals)) return false;
      const unique = new Set(vals.map(String));
      return unique.size >= 2 && unique.size <= 40;
    });
    const score = (h) => {
      let s = 0;
      if (isRecruiterCol(h)) s += 10;
      if (isStatusCol(h)) s += 9;
      if (isDeptCol(h)) s += 7;
      if (isRoleCol(h)) s += 6;
      if (/review|stage|priority|confidential|disposition|type|hm|manager|opening|req/i.test(h)) s += 5;
      if (/location|city|office|site/i.test(h)) s += 4;
      return s;
    };
    return [...catCols].sort((a,b)=>score(b)-score(a)).slice(0, 8);
  },[headers, data, analysis]);

  // ─── DERIVED: filtered data ───────────────────────────────────────────────
  const filteredData = useMemo(()=>{
    let d = [...data];
    Object.entries(activeFilters).forEach(([col,val])=>{
      if (!val) return;
      if (isStatusCol(col)) d=d.filter(r=>normalizeStatus(r[col]??"")===val);
      else d=d.filter(r=>String(r[col]??"")=== val);
    });
    return d;
  },[data, activeFilters]);

  const hasFilters = Object.values(activeFilters).some(Boolean);

  // ─── DERIVED: smart chart x-axis ─────────────────────────────────────────
  const chartXKey = useMemo(()=>{
    if (!analysis) return "";
    if (isPipelineReport) {
      const rec = headers.find(h=>isRecruiterCol(h));
      const dept = headers.find(h=>isDeptCol(h)&&h!==rec);
      const role = headers.find(h=>isRoleCol(h)&&h!==rec&&h!==dept);
      const activeRec = rec && activeFilters[rec];
      const activeDept = dept && activeFilters[dept];
      if ((activeRec||activeDept) && role) return role;
      if (rec) return rec;
      if (dept) return dept;
      return analysis.xKey;
    }
    const rec = headers.find(h=>isRecruiterCol(h));
    const status = headers.find(h=>isStatusCol(h));
    const activeRec = rec && activeFilters[rec];
    const activeStatus = status && activeFilters[status];
    if (activeRec && status) return status;
    if (activeStatus && rec) return rec;
    if (rec) return rec;
    return analysis.xKey;
  },[analysis, headers, activeFilters, isPipelineReport]);

  // ─── DERIVED: chart data ──────────────────────────────────────────────────
  const chartData = useMemo(()=>{
    if (!analysis||!filteredData.length) return [];
    const xk = chartXKey;
    if (isPipelineReport && pipelineNumericCols.length) {
      const groups = {};
      filteredData.forEach(row=>{
        const cell = rowValueForColumn(row, xk, headers) ?? row[xk];
        const key = String(cell ?? "Unknown");
        if (!groups[key]) { groups[key]={[xk]:key}; pipelineNumericCols.forEach(c=>{groups[key][shortStage(c)]=0;}); }
        pipelineNumericCols.forEach(c=>{ groups[key][shortStage(c)]+=(Number(row[c])||0); });
      });
      return Object.values(groups).sort((a,b)=>{
        const ta=pipelineNumericCols.reduce((s,c)=>s+(a[shortStage(c)]||0),0);
        const tb=pipelineNumericCols.reduce((s,c)=>s+(b[shortStage(c)]||0),0);
        return tb-ta;
      }).slice(0,15);
    }
    const groups = {};
    filteredData.forEach(row=>{
      const cell = rowValueForColumn(row, xk, headers) ?? row[xk];
      const rawKey = isStatusCol(xk)?normalizeStatus(String(cell ?? "")):String(cell ?? "Unknown");
      if (!groups[rawKey]) groups[rawKey]={[xk]:rawKey,Count:0};
      groups[rawKey].Count+=1;
    });
    return Object.values(groups).sort((a,b)=>b.Count-a.Count).slice(0,20);
  },[filteredData, analysis, chartXKey, isPipelineReport, pipelineNumericCols, headers]);

  // ─── DERIVED: summary cards ───────────────────────────────────────────────
  const summaryCards = useMemo(()=>{
    if (!analysis||!filteredData.length) return [];
    if (isPipelineReport && pipelineNumericCols.length) {
      const rec = headers.find(h=>isRecruiterCol(h));
      const dept = headers.find(h=>isDeptCol(h)&&h!==rec);
      const role = headers.find(h=>isRoleCol(h)&&h!==rec&&h!==dept);
      const groupCol = rec||dept||headers[0];
      const groups = {};
      filteredData.forEach(row=>{
        const key = String(row[groupCol]||"Unknown");
        if (!groups[key]) groups[key]={label:key,roles:new Set(),stageTotals:{}};
        if (role) groups[key].roles.add(String(row[role]||""));
        pipelineNumericCols.forEach(c=>{groups[key].stageTotals[c]=(groups[key].stageTotals[c]||0)+(Number(row[c])||0);});
      });
      return Object.values(groups).map(g=>({
        label:g.label, roleCount:g.roles.size,
        total:Object.values(g.stageTotals).reduce((s,v)=>s+v,0),
        stageTotals:g.stageTotals
      })).sort((a,b)=>b.total-a.total);
    }
    const rec = headers.find(h=>isRecruiterCol(h));
    const status = headers.find(h=>isStatusCol(h));
    if (rec) {
      const recruiters = [...new Set(filteredData.map(r=>String(r[rec]||"")))].filter(Boolean).sort();
      return recruiters.map(r=>{
        const rows = filteredData.filter(row=>String(row[rec]||"")===r);
        const sg = {};
        rows.forEach(row=>{ const s=status?normalizeStatus(String(row[status]||"")):"Unknown"; sg[s]=(sg[s]||0)+1; });
        return {recruiter:r.replace(/Primary /i,""),total:rows.length,statuses:sg};
      });
    }
    const gk = chartXKey || analysis?.xKey || headers.find(Boolean);
    if (!gk) return [];
    const tally = {};
    filteredData.forEach((row) => {
      const raw = rowValueForColumn(row, gk, headers) ?? row[gk];
      const k = String(raw ?? "Unknown");
      tally[k]=(tally[k]||0)+1;
    });
    return Object.entries(tally).sort((a,b)=>b[1]-a[1]).map(([label,total])=>({
      recruiter: label,
      total,
      statuses: { "Rows": total },
    }));
  },[filteredData,analysis,headers,isPipelineReport,pipelineNumericCols,chartXKey]);

  /** Table columns: sheet order first, then any extra keys present on rows. */
  const drillTableCols = useMemo(() => {
    if (!drillDown?.rows?.length) return [];
    const keysFromRows = new Set();
    drillDown.rows.forEach((r) => {
      if (r && typeof r === "object") Object.keys(r).forEach((k) => keysFromRows.add(k));
    });
    const ordered = headers.filter((h) => h && keysFromRows.has(h));
    const rest = [...keysFromRows].filter((k) => !ordered.includes(k));
    return [...ordered, ...rest].slice(0, 20);
  }, [drillDown, headers]);

  const openDrillForLabel = useCallback((labelStr) => {
    if (!analysis || labelStr == null || labelStr === "") return;
    const xk = chartXKey;
    if (!xk) return;
    const want = isStatusCol(xk) ? normalizeStatus(String(labelStr)) : String(labelStr);
    const rows = filteredData.filter((r) => {
      const raw = rowValueForColumn(r, xk, headers) ?? r[xk];
      if (raw == null && raw !== 0) return false;
      const val = isStatusCol(xk) ? normalizeStatus(String(raw)) : String(raw);
      return val === want;
    });
    if (rows.length) setDrillDown({ label: want, rows, isRecruiter: isRecruiterCol(xk) || isDeptCol(xk) });
  }, [analysis, chartXKey, filteredData, headers]);

  // ─── PROCESSING ───────────────────────────────────────────────────────────
  const startProc = () => {
    const msgs=["Reading your data...","Cleaning the report...","Finding the signal...","Building your brief..."];
    let i=0; setProcMsg(msgs[0]);
    procInterval.current=setInterval(()=>{i=(i+1)%msgs.length;setProcMsg(msgs[i]);},1800);
    setStep("processing");
  };
  const stopProc = () => clearInterval(procInterval.current);

  const resetAll = () => {
    setActiveFilters({}); setDrillDown(null);
    setSummaryOpen(true); setSignalsOpen(true); setViewMode("chart");
  };

  const run = async (hdrs, rows, name) => {
    setHeaders(hdrs); setData(rows); setFileName(name);
    resetAll(); startProc();
    try {
      const sample = rows.slice(0,60);
      const ctrl = new AbortController();
      const to = setTimeout(()=>ctrl.abort(), 45000);
      const res = await fetch("/api/chat",{
        method:"POST", signal:ctrl.signal,
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1200,
          messages:[{role:"user",content:`You are a senior talent analytics expert. Return ONLY valid JSON — no markdown, no backticks, no preamble.

Dataset: "${name}"
Columns: ${hdrs.join(", ")}
Total rows: ${rows.length}
Sample: ${JSON.stringify(sample)}

Identify report type: pipeline (multiple numeric stage columns like Recruiter Screen, HM Screen, Offer), time-to-hire, source-of-hire, headcount, recruiter-activity, offer-acceptance, dei, open-reqs, trend, or other.

For pipeline reports: xKey = the primary grouping column (recruiter name, department head, or department). yKeys = the stage columns (numeric).
For open-reqs: xKey = recruiter or department column. yKeys = ["Count"].
chartType: bar for comparisons, line/area for time trends 7+ points, pie for 3-7 proportions.

Return exactly:
{"title":"<6-8 word title>","reportType":"<type>","ats":"<lever|workday|ashby|greenhouse|unknown>","chartType":"bar"|"line"|"area"|"pie","xKey":"<exact column name>","yKeys":["<column names>"],"narrative":"<2-3 sentences for a CHRO. Biggest finding first. Real numbers.>","insights":["<finding with number>","<finding>","<finding>"],"suggestedQuestions":["<question>","<question>","<question>"]}

xKey and yKeys must be exact column names from the dataset.`}]
        })
      });
      clearTimeout(to); stopProc();
      const d = await readJsonResponse(res);
      if (d.error) throw new Error(d.error.message || String(d.error.type || "API error"));
      const json = JSON.parse(d.content[0].text.replace(/```json\n?|```/g,"").trim());
      setAnalysis({...json, totalRows:rows.length});
      setChatMsgs([]); setStep("results");
    } catch(e) {
      stopProc(); setStep("upload");
      setError(e.name==="AbortError"?"Timed out — try again.":`Analysis failed: ${e.message}`);
    }
  };

  const handleFile = async (file) => {
    setError("");
    try {
      if (file.name.match(/\.csv$/i)) { const {headers,rows}=parseCSV(await file.text()); await run(headers,rows,file.name); }
      else if (file.name.match(/\.xlsx?$/i)) {
        const XLSX=xlsxRef.current;
        if (!XLSX) { setError("Excel parser loading — try again."); return; }
        const wb=XLSX.read(await file.arrayBuffer(),{type:"arraybuffer"});
        const ws=wb.Sheets[wb.SheetNames[0]];
        const raw=XLSX.utils.sheet_to_json(ws,{header:1,defval:""});
        const rh=raw[0].map(String);
        const rawRows=raw.slice(1).filter(r=>r.some(v=>v!=="")).map(row=>{
          const obj={}; rh.forEach((h,i)=>{ const v=row[i]??""; obj[h]=typeof v==="number"?v:(!isNaN(parseFloat(String(v)))&&String(v).trim()!==""?parseFloat(String(v)):String(v)); }); return obj;
        });
        const {headers,rows}=cleanData(rh,rawRows);
        await run(headers,rows,file.name);
      } else setError("Upload a .csv or .xlsx file.");
    } catch { stopProc(); setStep("upload"); setError("Couldn't read that file. Try CSV."); }
  };

  const handleSheet = async () => {
    setError(""); const url=toCSVUrl(gsUrl.trim());
    if (!url) { setError("Not a valid Google Sheets URL."); return; }
    try { startProc(); const res=await fetch(url); if(!res.ok) throw new Error(); const {headers,rows}=parseCSV(await res.text()); await run(headers,rows,"Google Sheet"); }
    catch { stopProc(); setStep("upload"); setError('Share as "Anyone with link → Viewer" first.'); }
  };

  const handlePaste = async () => {
    setError(""); if(!pasteVal.trim()){setError("Paste your data first.");return;}
    try { const {headers,rows}=pasteVal.includes("\t")?parseTSV(pasteVal):parseCSV(pasteVal); await run(headers,rows,"Pasted Data"); }
    catch { setError("Couldn't parse. Copy directly from a spreadsheet."); }
  };

  const ask = async () => {
    if (!chatInput.trim()||asking) return;
    const msg=chatInput.trim(); setChatInput(""); setAsking(true);
    const updated=[...chatMsgs,{role:"user",content:msg}];
    setChatMsgs(updated);
    try {
      const res=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:800,
          system:`Talent analytics expert. Dataset: "${fileName}", ${data.length} rows. Columns: ${headers.join(", ")}. Sample: ${JSON.stringify(filteredData.slice(0,40))}. Be concise, cite numbers.`,
          messages:updated})});
      const d = await readJsonResponse(res);
      if (d.error) throw new Error(d.error.message || "API error");
      const reply = d.content?.[0]?.text ?? "No reply in response.";
      setChatMsgs([...updated,{role:"assistant",content:reply}]);
    } catch { setChatMsgs([...updated,{role:"assistant",content:"Error — please try again."}]); }
    setAsking(false);
  };

  const handleBarClick = (barData, index) => {
    if (!analysis) return;
    const xk = chartXKey;
    const payload = barData?.payload ?? barData;
    const row = typeof payload === "object" && payload !== null ? payload : {};
    let raw = rowValueForColumn(row, xk, headers) ?? row[xk];
    if ((raw == null || raw === "") && typeof index === "number" && chartData[index]) {
      const c = chartData[index];
      raw = rowValueForColumn(c, xk, headers) ?? c[xk];
    }
    if ((raw == null || raw === "") && barData?.originalDataIndex != null && chartData[barData.originalDataIndex]) {
      const c = chartData[barData.originalDataIndex];
      raw = rowValueForColumn(c, xk, headers) ?? c[xk];
    }
    if (raw == null && raw !== 0) return;
    const label = isStatusCol(xk) ? normalizeStatus(String(raw)) : String(raw);
    openDrillForLabel(label);
  };

  const renderChart = () => {
    if (!analysis||!chartData.length) return <div style={{padding:"2rem",textAlign:"center",color:T.dim,fontSize:13}}>No data for current filters</div>;
    const xk = chartXKey;
    const tt = {contentStyle:{background:T.card,border:`1px solid ${T.border}`,color:T.text,fontFamily:"Inter,sans-serif",fontSize:12,borderRadius:8,boxShadow:`${T.elev.md}`},labelStyle:{color:T.navy,fontWeight:600},cursor:{fill:"rgba(26,0,102,0.04)"}};
    const ax = {tick:{fill:T.muted,fontSize:11,fontFamily:"Inter,sans-serif"}};
    const barKeys = isPipelineReport ? pipelineNumericCols.map(c=>shortStage(c)) : ["Count"];
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={chartData} margin={{top:isPipelineReport?8:5,right:8,left:-15,bottom:isPipelineReport?90:70}} style={{cursor:"pointer"}}
          onClick={(state) => {
            const lab = state?.activeLabel;
            if (lab != null && lab !== "") openDrillForLabel(String(lab));
          }}>
          <CartesianGrid strokeDasharray="3 3" stroke={T.border}/>
          <XAxis dataKey={xk} {...ax} angle={-40} textAnchor="end" interval={0}/>
          <YAxis {...ax}/>
          <Tooltip {...tt}/>
          {barKeys.length>1&&<Legend verticalAlign="top" wrapperStyle={{fontFamily:"Inter,sans-serif",fontSize:10,color:T.muted,paddingBottom:8}}/>}
          {barKeys.map((k,i)=><Bar key={k} dataKey={k} fill={(isPipelineReport?T.pipeline:T.chart)[i%(isPipelineReport?T.pipeline:T.chart).length]} stackId="s" radius={i===barKeys.length-1?[3,3,0,0]:[0,0,0,0]} style={{cursor:"pointer"}} onClick={(data, idx, _e)=>handleBarClick(data, idx)}/>)}
        </BarChart>
      </ResponsiveContainer>
    );
  };

  const base = {minHeight:"100vh",background:pageBg,backgroundAttachment:"fixed",color:T.text,fontFamily:"Inter,sans-serif",fontSize:14};
  const cardShell = {background:T.card,border:`1px solid ${T.border}`,borderRadius:14,boxShadow:`${T.elev.sm}, ${T.elev.inset}`,overflow:"hidden"};
  const inputStyle = {background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontFamily:"Inter,sans-serif",fontSize:14,padding:"9px 12px",outline:"none",width:"100%",boxSizing:"border-box"};

  // ─── UPLOAD SCREEN ────────────────────────────────────────────────────────
  if (step==="upload") return (
    <div style={{...base,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"2rem 1rem"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        .sig-tab{background:transparent;color:${T.muted};border:none;cursor:pointer;font-family:Inter,sans-serif;font-size:13px;font-weight:500;padding:8px 18px;border-radius:8px;transition:all .15s;flex:1;}
        .sig-tab:hover{color:${T.text};}
        .sig-tab-on{background:${T.card};color:${T.text};font-weight:600;box-shadow:${T.elev.sm}, 0 0 0 1px ${T.border};}
        .sig-drop{transition:border-color .15s,background .15s,box-shadow .15s,transform .15s;box-shadow:${T.elev.sm};}
        .sig-drop:hover{border-color:${T.teal}!important;background:${T.tealLight}!important;box-shadow:${T.elev.md}!important;}
        .sig-btn{background:${T.navy};color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;font-family:Inter,sans-serif;cursor:pointer;width:100%;margin-top:12px;transition:background .15s,transform .15s,box-shadow .15s;box-shadow:0 4px 14px -2px rgba(26,0,102,0.35);}
        .sig-btn:hover{background:${T.navy2};transform:translateY(-1px);box-shadow:0 6px 20px -2px rgba(26,0,102,0.4);}
        .sig-btn:active{transform:translateY(0);}
        input:focus,select:focus,textarea:focus{border-color:${T.teal}!important;box-shadow:0 0 0 3px ${T.tealLight}!important;outline:none;}
        textarea{resize:vertical;}
      `}</style>
      <div style={{marginBottom:"2rem",textAlign:"center"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:16,marginBottom:12}}>
          <div style={{width:72,height:72,background:`linear-gradient(145deg, ${T.navy2} 0%, ${T.navy} 55%, #14004d 100%)`,borderRadius:18,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 2px 8px rgba(26,0,102,0.25), 0 16px 40px -10px rgba(26,0,102,0.45), inset 0 1px 0 rgba(255,255,255,0.12)`}}>
            <svg width="34" height="34" viewBox="0 0 18 18" fill="none"><rect x="2" y="10" width="3" height="6" rx="1" fill={T.teal}/><rect x="7" y="6" width="3" height="10" rx="1" fill={T.teal} opacity=".75"/><rect x="12" y="2" width="3" height="14" rx="1" fill={T.teal} opacity=".45"/></svg>
          </div>
          <div style={{textAlign:"left"}}>
            <div style={{fontSize:42,fontWeight:700,color:T.text,letterSpacing:-1.5,lineHeight:1}}>Signal</div>
            <div style={{fontSize:15,color:T.dim,marginTop:4}}>Your <span style={{color:T.teal2,fontWeight:700}}>talent</span> data, clearly.</div>
          </div>
        </div>
        <div style={{fontSize:13,color:T.muted,margin:"0 auto",lineHeight:1.6}}>
          Drop in a report from your <span style={{color:T.muted}}>People</span> team and <span style={{color:T.navy,fontWeight:600}}>Signal</span> will read it, visualize it, and help you tell the story.
        </div>
      </div>
      <div style={{width:"100%",maxWidth:500,...cardShell}}>
        <div style={{borderTop:`3px solid ${T.navy}`}}></div>
        <div style={{padding:"20px 24px 24px"}}>
          <div style={{display:"flex",gap:2,background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:3,marginBottom:20}}>
            {[["file","File"],["sheet","Google Sheet"],["paste","Paste"]].map(([t,l])=>(
              <button key={t} className={`sig-tab${tab===t?" sig-tab-on":""}`} onClick={()=>{setTab(t);setError("");}}>{l}</button>
            ))}
          </div>
          {tab==="file"&&(
            <div className="sig-drop" onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)}
              onDrop={e=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files[0];if(f)handleFile(f);}}
              onClick={()=>fileRef.current.click()}
              style={{border:`2px dashed ${dragOver?T.teal:T.border2}`,borderRadius:10,padding:"3rem 1rem",textAlign:"center",cursor:"pointer",background:dragOver?T.tealLight:T.surface}}>
              <div style={{width:40,height:40,background:T.tealLight,border:`1px solid ${T.tealMid}`,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px"}}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2v10M5 6l4-4 4 4" stroke={T.teal2} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M3 14h12" stroke={T.teal2} strokeWidth="1.8" strokeLinecap="round"/></svg>
              </div>
              <div style={{fontSize:14,fontWeight:500,color:T.text,marginBottom:4}}>Drop your file here</div>
              <div style={{color:T.dim,fontSize:12}}>CSV or Excel (.xlsx) · click to browse</div>
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{display:"none"}} onChange={e=>{if(e.target.files[0])handleFile(e.target.files[0]);}}/>
            </div>
          )}
          {tab==="sheet"&&(
            <div>
              <div style={{fontSize:12,color:T.muted,marginBottom:10,lineHeight:1.6}}>Share as <strong style={{color:T.text}}>"Anyone with link → Viewer"</strong> first.</div>
              <input value={gsUrl} onChange={e=>setGsUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." style={inputStyle}/>
              <button className="sig-btn" onClick={handleSheet}>Analyze sheet</button>
            </div>
          )}
          {tab==="paste"&&(
            <div>
              <div style={{fontSize:12,color:T.muted,marginBottom:10}}>Copy cells from any spreadsheet and paste below.</div>
              <textarea value={pasteVal} onChange={e=>setPasteVal(e.target.value)} placeholder="Paste CSV or spreadsheet data here..." rows={7} style={{...inputStyle,lineHeight:1.6}}/>
              <button className="sig-btn" onClick={handlePaste}>Analyze data</button>
            </div>
          )}
          {error&&<div style={{marginTop:14,padding:"10px 14px",background:T.redLight,border:"1px solid #FECACA",borderRadius:8,color:T.red,fontSize:13,lineHeight:1.5}}>{error}</div>}
        </div>
      </div>
    </div>
  );

  // ─── PROCESSING SCREEN ────────────────────────────────────────────────────
  if (step==="processing") return (
    <div style={{...base,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:"2rem"}}>
      <style>{`@keyframes wb{0%,100%{height:5px;opacity:.2}50%{height:32px;opacity:1}}`}</style>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:32,height:32,background:`linear-gradient(145deg, ${T.navy2}, ${T.navy})`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 2px 12px rgba(26,0,102,0.3), inset 0 1px 0 rgba(255,255,255,0.1)`}}>
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none"><rect x="2" y="10" width="3" height="6" rx="1" fill={T.teal}/><rect x="7" y="6" width="3" height="10" rx="1" fill={T.teal} opacity=".75"/><rect x="12" y="2" width="3" height="14" rx="1" fill={T.teal} opacity=".45"/></svg>
        </div>
        <span style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:-0.5}}>Signal</span>
      </div>
      <div style={{display:"flex",gap:4,alignItems:"flex-end",height:40}}>
        {[0,.08,.16,.24,.32,.40,.48,.56,.64,.72,.80].map((d,i)=>(
          <div key={i} style={{width:5,background:T.teal,borderRadius:3,animation:`wb .9s ease-in-out infinite`,animationDelay:`${d}s`}}/>
        ))}
      </div>
      <div style={{color:T.muted,fontSize:13,fontWeight:500}}>{procMsg}</div>
    </div>
  );

  // ─── RESULTS SCREEN ───────────────────────────────────────────────────────
  return (
    <div style={{...base,display:"flex",flexDirection:"column"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        @keyframes wb{0%,100%{height:4px;opacity:.2}50%{height:18px;opacity:1}}
        @keyframes su{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        .sq-chip{background:${T.card};border:1px solid ${T.border};color:${T.muted};border-radius:20px;padding:5px 14px;cursor:pointer;font-family:Inter,sans-serif;font-size:12px;font-weight:500;transition:all .15s;box-shadow:${T.elev.sm};}
        .sq-chip:hover{border-color:${T.tealMid};color:${T.text};background:${T.tealLight};box-shadow:${T.elev.md};transform:translateY(-1px);}
        .back-btn:hover{background:${T.surface}!important;color:${T.text}!important;}
        .ask-btn{background:linear-gradient(180deg, ${T.navy2} 0%, ${T.navy} 100%);color:#fff;border:none;border-radius:8px;padding:9px 18px;cursor:pointer;font-size:14px;font-weight:600;font-family:Inter,sans-serif;transition:background .15s,transform .15s,box-shadow .15s;box-shadow:0 3px 12px -2px rgba(26,0,102,0.35);}
        .ask-btn:hover{background:${T.navy2};transform:translateY(-1px);box-shadow:0 5px 16px -2px rgba(26,0,102,0.4);}
        .ask-btn:active{transform:translateY(0);}
        .ask-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;}
        .filter-sel{background:${T.card};border:1px solid ${T.border};border-radius:8px;color:${T.text};font-family:Inter,sans-serif;font-size:12px;padding:6px 10px;outline:none;cursor:pointer;transition:border-color .15s;}
        .filter-sel:focus{border-color:${T.teal};box-shadow:0 0 0 3px ${T.tealLight};}
        .view-btn{padding:6px 16px;border-radius:8px;font-size:12px;font-weight:500;font-family:Inter,sans-serif;cursor:pointer;border:none;transition:all .15s;}
        ::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:${T.border2};border-radius:2px;}
        @media(max-width:900px){.rg-insights{grid-template-columns:1fr!important;}}
        .dr:hover td{background:${T.tealLight}!important;}
        input:focus,select:focus{border-color:${T.teal}!important;box-shadow:0 0 0 3px ${T.tealLight}!important;}
      `}</style>

      {/* Header */}
      <div style={{background:"rgba(255,255,255,0.86)",backdropFilter:"blur(14px)",WebkitBackdropFilter:"blur(14px)",borderBottom:`1px solid ${T.border}`,boxShadow:T.elev.header,padding:"0 24px",height:60,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,position:"sticky",top:0,zIndex:20}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:28,height:28,background:`linear-gradient(145deg, ${T.navy2}, ${T.navy})`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 2px 8px rgba(26,0,102,0.28), inset 0 1px 0 rgba(255,255,255,0.12)`}}>
            <svg width="14" height="14" viewBox="0 0 18 18" fill="none"><rect x="2" y="10" width="3" height="6" rx="1" fill={T.teal}/><rect x="7" y="6" width="3" height="10" rx="1" fill={T.teal} opacity=".75"/><rect x="12" y="2" width="3" height="14" rx="1" fill={T.teal} opacity=".45"/></svg>
          </div>
          <span style={{fontSize:16,fontWeight:700,color:T.text}}>Signal</span>
          {analysis?.ats&&analysis.ats!=="unknown"&&<span style={{fontSize:11,fontWeight:600,background:T.tealLight,color:T.teal2,border:`1px solid ${T.tealMid}`,borderRadius:20,padding:"2px 10px",textTransform:"capitalize"}}>{analysis.ats}</span>}
          {analysis?.reportType&&<span style={{fontSize:11,fontWeight:500,background:T.surface,color:T.muted,border:`1px solid ${T.border}`,borderRadius:20,padding:"2px 10px",textTransform:"capitalize"}}>{analysis.reportType.replace(/-/g," ")}</span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:12,color:T.dim}}>{fileName} · {hasFilters?<span style={{color:T.navy,fontWeight:600}}>{filteredData.length} of </span>:""}{data.length.toLocaleString()} rows</span>
          <button onClick={async ()=>{ await exportPDF(analysis,summaryCards,fileName,isPipelineReport,pipelineNumericCols,activeFilters,filteredData.length,data.length,filteredData); }}
            style={{background:`linear-gradient(180deg, ${T.navy2} 0%, ${T.navy} 100%)`,color:"#fff",border:"none",borderRadius:8,padding:"5px 14px",cursor:"pointer",fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:600,transition:"background .15s,transform .15s,box-shadow .15s",boxShadow:"0 2px 10px -1px rgba(26,0,102,0.35)"}}>
            Export PDF
          </button>
          <button className="back-btn" onClick={()=>{setStep("upload");setAnalysis(null);setChatMsgs([]);setError("");resetAll();}}
            style={{background:"transparent",border:`1px solid ${T.border}`,color:T.muted,borderRadius:8,padding:"5px 14px",cursor:"pointer",fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:500,transition:"all .15s"}}>
            ← New report
          </button>
        </div>
      </div>

      <div style={{padding:"20px 24px 48px",maxWidth:1100,margin:"0 auto",width:"100%",boxSizing:"border-box"}}>
        <h1 style={{fontSize:22,fontWeight:700,color:T.text,margin:"0 0 6px",letterSpacing:-0.45,textShadow:"0 1px 0 rgba(255,255,255,0.9)"}}>{analysis?.title}</h1>
        <p style={{fontSize:13,color:T.muted,margin:"0 0 20px",lineHeight:1.5}}>
          {isPipelineReport ? "Pipeline view — chart reflects your filters. Click a bar for row details." : "Click a bar to inspect the underlying rows."}
        </p>

        {/* Story first: brief + key signals */}
        <div className="rg-insights" style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:18,marginBottom:20}}>
          <div style={{...cardShell,display:"flex",flexDirection:"column",minHeight:0}}>
            <div onClick={()=>setSummaryOpen(o=>!o)} style={{padding:"13px 18px 11px",borderBottom:summaryOpen?`1px solid ${T.border}`:"none",borderTop:`3px solid ${T.teal}`,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",flexShrink:0}}>
              <span style={{fontSize:11,fontWeight:600,color:T.muted,letterSpacing:"0.06em",textTransform:"uppercase"}}>The Brief</span>
              <span style={{fontSize:14,color:T.dim}}>{summaryOpen?"−":"+"}</span>
            </div>
            {summaryOpen&&<div style={{padding:"16px 18px",flex:1}}><p style={{fontSize:14,lineHeight:1.75,color:T.text,margin:0}}>{analysis?.narrative}</p></div>}
          </div>
          <div style={{...cardShell,display:"flex",flexDirection:"column",minHeight:0}}>
            <div onClick={()=>setSignalsOpen(o=>!o)} style={{padding:"13px 18px 11px",borderBottom:signalsOpen?`1px solid ${T.border}`:"none",borderTop:`3px solid ${T.navy}`,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",flexShrink:0}}>
              <span style={{fontSize:11,fontWeight:600,color:T.muted,letterSpacing:"0.06em",textTransform:"uppercase"}}>Key signals</span>
              <span style={{fontSize:14,color:T.dim}}>{signalsOpen?"−":"+"}</span>
            </div>
            {signalsOpen&&<div style={{padding:"14px 18px"}}>
              {analysis?.insights?.map((ins,i)=>(
                <div key={i} style={{display:"flex",gap:10,marginBottom:i<analysis.insights.length-1?10:0,alignItems:"flex-start"}}>
                  <div style={{width:20,height:20,background:i===0?T.tealLight:T.surface,border:`1px solid ${i===0?T.tealMid:T.border}`,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>
                    <span style={{fontSize:10,fontWeight:700,color:i===0?T.teal2:T.muted}}>{i+1}</span>
                  </div>
                  <div style={{fontSize:13,lineHeight:1.65,color:T.muted}}>{ins}</div>
                </div>
              ))}
            </div>}
          </div>
        </div>

        {/* Filters — directly above the chart they affect */}
        {(filterCols.length>0||headers.length>0)&&(
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 16px",marginBottom:16,display:"flex",flexWrap:"wrap",gap:10,alignItems:"flex-end",boxShadow:`${T.elev.sm}, ${T.elev.inset}`}}>
            <span style={{fontSize:11,fontWeight:600,color:T.muted,letterSpacing:"0.06em",textTransform:"uppercase",marginRight:4,paddingBottom:2}}>Filters</span>
            {filterCols.map(col=>(
              <div key={col} style={{display:"flex",flexDirection:"column",gap:3}}>
                <label style={{fontSize:10,color:T.dim,fontWeight:500}}>{col.replace(/Primary /i,"")}</label>
                <select className="filter-sel" value={activeFilters[col]||""} onChange={e=>{setActiveFilters(p=>({...p,[col]:e.target.value}));setDrillDown(null);}}>
                  <option value="">All</option>
                  {uniqueVals(data,col).map(v=><option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            ))}
            {hasFilters&&(
              <button onClick={()=>{setActiveFilters({});setDrillDown(null);}}
                style={{background:"transparent",border:`1px solid ${T.border}`,color:T.muted,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontFamily:"Inter,sans-serif",fontSize:12,fontWeight:500,marginLeft:"auto",transition:"all .15s"}}>
                Clear filters
              </button>
            )}
            {filterCols.length===0&&(
              <span style={{fontSize:12,color:T.dim,marginLeft:"auto"}}>No filterable columns detected (need 2+ values per column).</span>
            )}
          </div>
        )}

        {/* Chart or Summary cards */}
        <div style={{...cardShell,marginBottom:18}}>
          <div style={{padding:"10px 14px 10px",borderBottom:`1px solid ${T.border}`,borderTop:`3px solid ${T.navy}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
            <div style={{display:"flex",gap:2,background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:3}}>
              {[["chart","Chart"],["cards","Summary"]].map(([m,l])=>(
                <button key={m} type="button" className="view-btn" onClick={()=>setViewMode(m)}
                  style={{background:viewMode===m?T.card:"transparent",color:viewMode===m?T.text:T.muted,
                    boxShadow:viewMode===m?`${T.elev.sm}, 0 0 0 1px ${T.border}`:"none"}}>
                  {l}
                </button>
              ))}
            </div>
            {hasFilters&&viewMode==="chart"&&<span style={{fontSize:11,color:T.teal2,fontWeight:500}}>Filtered data</span>}
          </div>
          {viewMode==="chart"?(
            <div style={{padding:"14px 8px 8px",background:`linear-gradient(180deg, rgba(246,247,245,0.5) 0%, ${T.card} 28%)`}}>
              {renderChart()}
              {chartData.length>0&&(
                <>
                  <div style={{fontSize:11,color:T.dim,textAlign:"center",marginTop:4,paddingBottom:8}}>Click a bar, the chart background, or a name below to preview rows.</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"4px 12px 14px",justifyContent:"center"}}>
                    {chartData.map((row, i) => {
                      const xk = chartXKey;
                      const lab = rowValueForColumn(row, xk, headers) ?? row[xk];
                      const n = isPipelineReport ? pipelineNumericCols.reduce((s,c)=>s+(Number(row[shortStage(c)])||0),0) : (row.Count ?? 0);
                      return (
                        <button key={i} type="button" onClick={()=>openDrillForLabel(String(lab))}
                          style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:20,padding:"6px 12px",fontSize:12,cursor:"pointer",fontFamily:"Inter,sans-serif",color:T.text}}>
                          {String(lab)} <span style={{color:T.muted}}>({n})</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ):(
            <div style={{padding:"14px 16px 18px",display:"flex",flexDirection:"column",gap:10,maxHeight:480,overflowY:"auto"}}>
              {summaryCards.length===0?<div style={{color:T.dim,fontSize:13,textAlign:"center",padding:"2rem"}}>No summary for this dataset</div>:
              summaryCards.map((card,i)=>(
                <div key={i} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 14px",boxShadow:`${T.elev.sm}`}}>
                  {isPipelineReport?(
                    <>
                      <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                        <span style={{fontSize:13,fontWeight:600,color:T.navy}}>{card.label}</span>
                        <span style={{fontSize:12,color:T.dim}}>{card.roleCount} role{card.roleCount!==1?"s":""}</span>
                        <span style={{fontSize:12,fontWeight:600,color:T.teal2,marginLeft:"auto"}}>{card.total} total candidates</span>
                      </div>
                      <div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                          <thead>
                            <tr>
                              {Object.keys(card.stageTotals).map(stage=>(
                                <th key={stage} style={{padding:"4px 8px",textAlign:"center",fontSize:10,fontWeight:600,color:T.muted,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap"}}>
                                  {stage.replace("Recruiter Screen","Screen").replace("Hiring Manager Screen","HM Screen").replace("Virtual Interview","Virtual").replace("Onsite Interview","Onsite").replace("Final Round","Final")}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              {Object.entries(card.stageTotals).map(([stage,count])=>(
                                <td key={stage} style={{padding:"6px 8px",textAlign:"center",fontWeight:600,fontSize:13,color:count>0?T.navy:T.dim,background:count>0?T.tealLight:"transparent",borderRadius:6}}>
                                  {count||"—"}
                                </td>
                              ))}
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  ):(
                    <>
                      <div style={{fontSize:13,fontWeight:600,color:T.navy,marginBottom:8}}>
                        {card.recruiter} <span style={{color:T.dim,fontWeight:400,fontSize:12}}>· {card.total} req{card.total!==1?"s":""}</span>
                      </div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                        {Object.entries(card.statuses).sort((a,b)=>b[1]-a[1]).map(([s,c])=>{
                          const cm={"Open, actively recruiting":[T.tealLight,T.teal2],"Filled":[T.greenLight,T.green],"On Hold":[T.amberLight,T.amber],"Open, not actively recruiting":[T.surface,T.muted]};
                          const [bg,fg]=cm[s]||[T.surface,T.muted];
                          return <span key={s} style={{fontSize:11,fontWeight:500,background:bg,color:fg,border:`1px solid ${fg}33`,borderRadius:20,padding:"3px 10px"}}>{c} · {s}</span>;
                        })}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Drill-down */}
        {drillDown&&(
          <div style={{...cardShell,border:`1px solid ${T.tealMid}`,boxShadow:`0 8px 32px -8px rgba(56,184,175,0.22), ${T.elev.md}, ${T.elev.inset}`,marginBottom:14,animation:"su .2s ease"}}>
            <div style={{padding:"13px 18px 11px",borderBottom:`1px solid ${T.border}`,borderTop:`3px solid ${T.teal}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:11,fontWeight:600,color:T.muted,letterSpacing:"0.06em",textTransform:"uppercase"}}>{drillDown.isRecruiter?"Recruiter brief":"Drill-down"}</div>
                <div style={{fontSize:13,fontWeight:600,color:T.navy,marginTop:2}}>{drillDown.label} <span style={{color:T.dim,fontWeight:400}}>· {drillDown.rows.length} row{drillDown.rows.length!==1?"s":""}</span></div>
              </div>
              <button onClick={()=>setDrillDown(null)} style={{background:"transparent",border:`1px solid ${T.border}`,color:T.muted,borderRadius:8,padding:"5px 12px",cursor:"pointer",fontFamily:"Inter,sans-serif",fontSize:12}}>✕ Close</button>
            </div>
            <div style={{overflowX:"auto",minHeight:drillTableCols.length?undefined:48}}>
              {drillTableCols.length>0?(
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr style={{background:T.surface}}>{drillTableCols.map(c=><th key={c} style={{padding:"8px 14px",textAlign:"left",fontWeight:600,color:T.muted,borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",fontSize:11}}>{c}</th>)}</tr></thead>
                  <tbody>{drillDown.rows.slice(0,25).map((row,i)=>(
                    <tr key={i} className="dr" style={{borderBottom:`1px solid ${T.border}`}}>
                      {drillTableCols.map(c=><td key={c} style={{padding:"8px 14px",color:T.text,whiteSpace:"nowrap",maxWidth:280,overflow:"hidden",textOverflow:"ellipsis",background:"transparent",transition:"background .1s"}} title={String(rowValueForColumn(row,c,headers)??row[c]??"")}>{String(rowValueForColumn(row,c,headers)??row[c]??"—")}</td>)}
                    </tr>
                  ))}</tbody>
                </table>
              ):(
                <div style={{padding:"16px 18px",fontSize:13,color:T.text,lineHeight:1.6}}>
                  {drillDown.rows[0]&&typeof drillDown.rows[0]==="object"?Object.entries(drillDown.rows[0]).map(([k,v])=>(
                    <div key={k} style={{display:"flex",gap:8,marginBottom:6}}><span style={{color:T.muted,flexShrink:0}}>{k}</span><span>{String(v??"—")}</span></div>
                  )):<span style={{color:T.dim}}>No row fields found.</span>}
                </div>
              )}
              {drillDown.rows.length>25&&<div style={{padding:"10px 18px",fontSize:12,color:T.dim,borderTop:`1px solid ${T.border}`}}>Showing 25 of {drillDown.rows.length} rows</div>}
            </div>
          </div>
        )}

        {/* Ask Signal */}
        <div style={{...cardShell,boxShadow:`${T.elev.md}, ${T.elev.inset}`}}>
          <div style={{padding:"13px 18px",borderBottom:`1px solid ${T.border}`,borderTop:`3px solid ${T.navy}`,display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:11,fontWeight:600,color:T.muted,letterSpacing:"0.06em",textTransform:"uppercase"}}>Ask Signal</span>
            <span style={{fontSize:12,color:T.dim}}>— ask anything about this report</span>
          </div>
          {chatMsgs.length===0&&(
            <div style={{padding:"14px 18px",display:"flex",flexWrap:"wrap",gap:8,borderBottom:`1px solid ${T.border}`}}>
              {analysis?.suggestedQuestions?.map((q,i)=><button key={i} className="sq-chip" onClick={()=>setChatInput(q)}>{q}</button>)}
            </div>
          )}
          {chatMsgs.length>0&&(
            <div style={{maxHeight:320,overflowY:"auto",padding:"16px 18px",display:"flex",flexDirection:"column",gap:12}}>
              {chatMsgs.map((m,i)=>(
                <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                  <div style={{maxWidth:"80%",padding:"10px 14px",borderRadius:m.role==="user"?"12px 12px 3px 12px":"12px 12px 12px 3px",background:m.role==="user"?`linear-gradient(175deg, ${T.navy2}, ${T.navy})`:T.surface,border:m.role==="assistant"?`1px solid ${T.border}`:"none",color:m.role==="user"?"#fff":T.text,fontSize:13,lineHeight:1.65,whiteSpace:"pre-wrap",boxShadow:m.role==="user"?"0 3px 12px rgba(26,0,102,0.22)":`${T.elev.sm}`}}>{m.content}</div>
                </div>
              ))}
              {asking&&<div style={{display:"flex"}}><div style={{padding:"10px 16px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:"12px 12px 12px 3px"}}><div style={{display:"flex",gap:4,alignItems:"flex-end",height:20}}>{[0,.2,.4].map((d,i)=><div key={i} style={{width:4,background:T.teal,borderRadius:2,animation:"wb .7s ease-in-out infinite",animationDelay:`${d}s`}}/>)}</div></div></div>}
              <div ref={chatEndRef}/>
            </div>
          )}
          <div style={{padding:"12px 18px",display:"flex",gap:8,borderTop:chatMsgs.length>0?`1px solid ${T.border}`:"none",background:T.surface}}>
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&ask()} placeholder="Ask a question about this data..."
              style={{flex:1,background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontFamily:"Inter,sans-serif",fontSize:13,padding:"9px 12px",outline:"none"}}/>
            <button className="ask-btn" onClick={ask} disabled={asking}>→</button>
          </div>
        </div>
      </div>
    </div>
  );
}
