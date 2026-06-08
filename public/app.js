"use strict";

/* ---------------- State ---------------- */
const CACHE_KEY = "ayanu.cache.v2";   // offline mirror, keyed by workspace id
let currentDate = todayStr();
let calYM = currentDate.slice(0,7);   // "YYYY-MM" month shown in the calendar
let currentUserEmail = null;

let wsList = [];          // workspace metadata: [{id,name,kind,role,member_count}]
let pendingInvites = [];  // email invites awaiting me: [{token,role,workspace_name}]
let currentWsId = null;   // selected workspace
let data = emptyData();   // content of the current workspace: {tickets, ac}
let pendingSelectWs = null; // workspace to open after processing an invite/join link

let viewMode = "edit";          // "edit" | "aggregate" | "overview"
const AGG_ID = "__aggregate__"; // sentinel id for the combined "全体混合" view
let aggData = null;             // { workspaces:[{id,name,kind,data}] } for aggregate
let overviewData = null;        // { members:[{id,email,username,role,data}] } for overview

function emptyData(){ return { tickets:{}, ac:[] }; }
function normalizeData(d){
  if(!d || typeof d!=="object") d={};
  if(!d.tickets || typeof d.tickets!=="object") d.tickets={};
  if(!Array.isArray(d.ac)) d.ac=[];
  return d;
}

/* ---- API ---- */
async function api(path, opts={}){
  const res = await fetch("/api"+path, {
    method: opts.method || "GET",
    headers: opts.body ? {"Content-Type":"application/json"} : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "include",
  });
  let body=null; try{ body=await res.json(); }catch(_){}
  if(!res.ok) throw new Error((body && body.error) || ("HTTP "+res.status));
  return body;
}

/* ---- persistence (per workspace, debounced) ---- */
let saveTimer=null, dirty=false, suppressSave=false;
function setSyncStatus(s){
  const el=document.getElementById("syncStatus");
  if(el) el.textContent = s==="saving"?"保存中…" : s==="saved"?"保存済み" : s==="error"?"保存失敗" : "";
}
/* Render without scheduling a server write — for programmatic loads (switch/refresh). */
function renderClean(){ suppressSave=true; try{ render(); } finally { suppressSave=false; } }
/* Called by the app on every change. */
function save(){
  if(!currentWsId || viewMode!=="edit" || currentWsId===AGG_ID) return; // read-only modes don't persist
  try{ localStorage.setItem(CACHE_KEY+":"+currentWsId, JSON.stringify(data)); }catch(_){} // always mirror to cache
  if(suppressSave || !currentUserEmail) return;   // programmatic load: cache only, no server write / no dirty
  dirty=true; setSyncStatus("saving");
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>persist(currentWsId), 600);
}
async function persist(wsId){
  if(!dirty) return;
  dirty=false;
  try{ await api("/workspaces/"+wsId+"/data", {method:"PUT", body:{data}}); setSyncStatus("saved"); }
  catch(_){ dirty=true; setSyncStatus("error"); }
}
/* Flush any pending change before switching workspace (so it saves to the right one). */
async function flushSave(){
  clearTimeout(saveTimer);
  if(dirty && currentUserEmail && currentWsId) await persist(currentWsId);
}

/** Current workspace's content object {tickets, ac}. */
function ws(){ return data; }
/** Metadata of the current workspace (name, role, kind). */
function curWs(){ return wsList.find(w=>w.id===currentWsId) || null; }
/** The shared AfterCheck list for the current workspace. */
function acList(){ if(!Array.isArray(data.ac)) data.ac=[]; return data.ac; }

function isoOf(d){
  const off = d.getTimezoneOffset();
  return new Date(d.getTime()-off*60000).toISOString().slice(0,10);
}
function todayStr(){ return isoOf(new Date()); }
function uid(){ return Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4); }

/** Get (creating if needed) the ticket for the current date in the current workspace. */
function ticket(){
  if(!data.tickets[currentDate]) data.tickets[currentDate] = {tasks:[], todos:[]};
  return data.tickets[currentDate];
}

/* ---------------- Task helpers ---------------- */
function newTask(text){
  return {id:uid(), text:text||"", est:"", prio:"top", comment:"", showComment:false, done:false, children:[]};
}
function newTodo(text){ return {id:uid(), text:text||"", done:false}; }

/* Find a task + its sibling array by id (searches parents and children). */
function findTask(id, list){
  list = list || ticket().tasks;
  for(const t of list){
    if(t.id===id) return {task:t, list};
    const inChild = findTask(id, t.children);
    if(inChild) return inChild;
  }
  return null;
}

/* Return the parent task whose children contain `task`, or null if top-level. */
function findParent(task, list){
  list = list || ticket().tasks;
  for(const t of list){
    if(t.children.includes(task)) return t;
    const p = findParent(task, t.children);
    if(p) return p;
  }
  return null;
}

/* Tab: make `task` a child of the previous sibling (1 level deep max). */
function indentTask(task){
  if(findParent(task)) return;                 // already a child → max depth
  if(task.children.length) return;             // would create depth>1 → skip
  const list = ticket().tasks;
  const i = list.indexOf(task);
  if(i <= 0) return;                           // no previous sibling to nest under
  const prev = list[i-1];
  list.splice(i,1);
  prev.children.push(task);
  render(); focusTask(task.id);
}

/* Shift+Tab: move a child back up to the top level, just after its parent. */
function outdentTask(task){
  const parent = findParent(task);
  if(!parent) return;                          // already top-level
  parent.children.splice(parent.children.indexOf(task),1);
  const list = ticket().tasks;
  list.splice(list.indexOf(parent)+1, 0, task);
  render(); focusTask(task.id);
}

/* Enter: add a new sibling row right after `task` (same level). */
function addSiblingAfter(task){
  const f = findTask(task.id);
  const n = newTask("");
  f.list.splice(f.list.indexOf(task)+1, 0, n);
  render(); focusTask(n.id);
}

/* Move keyboard focus to a task's text field (cursor at end). */
function focusTask(id){
  const el = document.querySelector('.task-row[data-id="'+id+'"] .task-text');
  if(el){ el.focus(); const v=el.value; el.setSelectionRange(v.length, v.length); }
}

/* ---------------- Rendering ---------------- */
const taskListEl = document.getElementById("taskList");
const todoListEl = document.getElementById("todoList");

function render(){
  renderWorkspaces();
  renderCalendar();
  renderDayList();
  renderTasks();
  renderTodos();
  save();
}

/* ---------------- Month calendar ---------------- */
function ticketHasContent(t){ return t && t.tasks.length>0; }

function shiftMonth(delta){
  let [y,m]=calYM.split("-").map(Number);
  const d=new Date(y, m-1+delta, 1);
  calYM = d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
  render();
}

function renderCalendar(){
  const el=document.getElementById("calendar");
  const [y,m]=calYM.split("-").map(Number);
  const first=new Date(y, m-1, 1);
  const startDow=first.getDay();
  const daysInMonth=new Date(y, m, 0).getDate();
  const today=todayStr();
  const tickets=ws().tickets;
  el.innerHTML="";

  // header
  const head=document.createElement("div"); head.className="cal-head";
  const prev=document.createElement("button"); prev.className="nav"; prev.textContent="‹"; prev.onclick=()=>shiftMonth(-1);
  const label=document.createElement("span"); label.className="m"; label.textContent=y+"年"+m+"月";
  const next=document.createElement("button"); next.className="nav"; next.textContent="›"; next.onclick=()=>shiftMonth(1);
  const sp=document.createElement("span"); sp.className="sp";
  head.append(prev,label,sp,next);
  el.appendChild(head);

  // grid
  const grid=document.createElement("div"); grid.className="cal-grid";
  ["日","月","火","水","木","金","土"].forEach((w,i)=>{
    const c=document.createElement("div"); c.className="wd"+(i===0?" sun":i===6?" sat":""); c.textContent=w; grid.appendChild(c);
  });
  const cells=Math.ceil((startDow+daysInMonth)/7)*7;
  for(let i=0;i<cells;i++){
    const dayNum=i-startDow+1;
    const date=new Date(y, m-1, dayNum);
    const ds=isoOf(date);
    const cell=document.createElement("div");
    cell.className="cal-cell";
    cell.textContent=date.getDate();
    const inMonth = dayNum>=1 && dayNum<=daysInMonth;
    if(!inMonth) cell.classList.add("out");
    if(ds===today) cell.classList.add("today");
    if(ds===currentDate) cell.classList.add("active");
    if(ticketHasContent(tickets[ds])){ const dot=document.createElement("span"); dot.className="dot"; cell.appendChild(dot); }
    cell.onclick=()=>{ currentDate=ds; calYM=ds.slice(0,7); render(); };
    grid.appendChild(cell);
  }
  el.appendChild(grid);
}

/* ---------------- Workspaces ---------------- */
function roleLabel(r){ return r==="owner"?"オーナー" : r==="admin"?"管理者" : "メンバー"; }

/* Tiny DOM builder. el('div',{class:'x',onClick:fn,text:'hi'}, child1, child2) */
function el(tag, props={}, ...kids){
  const e=document.createElement(tag);
  for(const [k,v] of Object.entries(props)){
    if(v==null) continue;
    if(k==="class") e.className=v;
    else if(k==="text") e.textContent=v;
    else if(k.slice(0,2)==="on") e[k.toLowerCase()]=v;
    else if(k==="value") e.value=v;
    else e.setAttribute(k,v);
  }
  kids.flat().forEach(k=>{ if(k!=null) e.appendChild(typeof k==="string"?document.createTextNode(k):k); });
  return e;
}

/* ---- floating "⋯" (kebab) menu ---- */
let _menuEl=null, _menuAnchor=null;
function closeMenu(){
  if(!_menuEl) return;
  _menuEl.remove(); _menuEl=null; _menuAnchor=null;
  document.removeEventListener("mousedown",_menuOutside,true);
  document.removeEventListener("scroll",closeMenu,true);
  window.removeEventListener("resize",closeMenu);
}
function _menuOutside(e){
  // ignore clicks on the trigger itself so its handler can toggle the menu closed
  if(_menuEl && !_menuEl.contains(e.target) && !(_menuAnchor && _menuAnchor.contains(e.target))) closeMenu();
}
/* items: [{label, icon?, danger?, onClick} | {sep:true}] */
function openMenu(anchor, items){
  const reopen = _menuAnchor===anchor;
  closeMenu();
  if(reopen) return;   // clicking the same trigger again just closes
  const m=el("div",{class:"kebab-menu"});
  _menuAnchor=anchor;
  items.forEach(it=>{
    if(it.sep){ m.appendChild(el("div",{class:"kebab-sep"})); return; }
    m.appendChild(el("button",{class:"kebab-item"+(it.danger?" danger":""), onClick:()=>{ closeMenu(); it.onClick(); }},
      el("span",{class:"kebab-ic", text:it.icon||""}),
      el("span",{text:it.label})
    ));
  });
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect();
  let left=r.right-m.offsetWidth, top=r.bottom+4;
  if(left<8) left=8;
  if(top+m.offsetHeight>window.innerHeight-8) top=Math.max(8, r.top-m.offsetHeight-4);
  m.style.top=top+"px"; m.style.left=left+"px";
  _menuEl=m;
  setTimeout(()=>{
    document.addEventListener("mousedown",_menuOutside,true);
    document.addEventListener("scroll",closeMenu,true);
    window.addEventListener("resize",closeMenu);
  },0);
}
/* deep-clone a task / todo with fresh ids */
function cloneTask(t){ return {...t, id:uid(), children:(t.children||[]).map(cloneTask)}; }
function cloneTodo(td){ return {...td, id:uid()}; }

function renderWorkspaces(){
  const cur=curWs();
  document.getElementById("wsCurrent").textContent =
      viewMode==="aggregate" ? "全体混合"
    : viewMode==="overview"  ? ((cur?cur.name:"")+"（メンバー状況）")
    : (cur ? cur.name : "—");
  const list=document.getElementById("wsList");
  list.innerHTML="";

  // combined view across all of my workspaces
  list.appendChild(el("li",{class:"ws-aggregate"+(currentWsId===AGG_ID?" active":"")},
    el("span",{class:"ws-dot"}),
    el("span",{class:"ws-li-name", text:"📋 全体混合", onClick:openAggregate})
  ));

  // pending invitations
  if(pendingInvites.length){
    list.appendChild(el("div",{class:"ws-group-head"},"招待"));
    pendingInvites.forEach(inv=>{
      list.appendChild(el("li",{class:"ws-invite"},
        el("span",{class:"ws-li-name", text:"『"+inv.workspace_name+"』"}),
        el("button",{class:"mini-btn primary", text:"参加", onClick:async()=>{
          try{ const r=await api("/invites/"+inv.token+"/accept",{method:"POST"});
            await refreshWorkspaces(); await selectWorkspace(r.workspaceId);
          }catch(e){ alert(e.message); } }}),
        el("button",{class:"mini-btn", text:"拒否", onClick:async()=>{
          try{ await api("/invites/"+inv.token+"/decline",{method:"POST"}); await refreshWorkspaces(); }
          catch(e){ alert(e.message); } }})
      ));
    });
  }

  [["personal","マイワークスペース"],["team","チーム"]].forEach(([kind,label])=>{
    const items=wsList.filter(w=>w.kind===kind);
    if(!items.length) return;
    list.appendChild(el("div",{class:"ws-group-head"},label));
    items.forEach(w=>{
      const name=el("span",{class:"ws-li-name", text:w.name, onClick:()=>selectWorkspace(w.id)});
      const more=el("button",{class:"icon-btn ws-more", text:"⋯", title:"設定"});
      more.onclick=(e)=>{ e.stopPropagation(); openMenu(more,[
        {label:"共有・メンバー設定", icon:"⚙", onClick:()=>openShare(w.id)},
        ...(w.role==="owner" ? [
          {sep:true},
          {label:"ワークスペースを削除", icon:"🗑", danger:true, onClick:async()=>{
            if(!confirm("『"+w.name+"』を削除しますか？すべての日報・メンバーが削除されます。")) return;
            try{ await api("/workspaces/"+w.id,{method:"DELETE"});
              if(currentWsId===w.id) await repickWorkspace();
              else await refreshWorkspaces();
            }catch(err){ alert(err.message); }
          }},
        ] : []),
      ]); };
      list.appendChild(el("li",{class:((w.id===currentWsId && viewMode!=="aggregate")?"active":"")},
        el("span",{class:"ws-dot"}),
        name,
        el("span",{class:"ws-role", text:roleLabel(w.role)}),
        w.member_count>1 ? el("span",{class:"ws-members", title:"メンバー数", text:"👤"+w.member_count}) : null,
        more
      ));
    });
  });
}

/* reload workspace list + invites and refresh the drawer */
async function refreshWorkspaces(){
  try{ const r=await api("/workspaces"); wsList=r.workspaces||[]; pendingInvites=r.invites||[]; }catch(_){}
  renderWorkspaces();
}

/* switch the active workspace */
async function selectWorkspace(id){
  if(id===currentWsId && viewMode==="edit"){ closeDrawer(); return; }
  await flushSave();
  currentWsId=id;
  try{ localStorage.setItem("ayanu.lastWs", id); }catch(_){}
  setView("edit"); updateModeButtons();
  closeDrawer();
  currentDate=todayStr(); calYM=currentDate.slice(0,7);

  // instant: render the cached copy right away
  let cached=null; try{ cached=JSON.parse(localStorage.getItem(CACHE_KEY+":"+id)); }catch(_){}
  data=normalizeData(cached);
  renderClean(); setSyncStatus("saved");

  // then refresh from the server; apply only if still here and the user hasn't edited
  try{
    const r=await api("/workspaces/"+id+"/data");
    if(id===currentWsId && viewMode==="edit" && !dirty){ data=normalizeData(r.data); renderClean(); }
  }catch(_){ /* keep the cached copy */ }
}

async function loadWorkspaceData(){
  try{ const r=await api("/workspaces/"+currentWsId+"/data"); data=normalizeData(r.data); }
  catch(_){
    let cached=null; try{ cached=JSON.parse(localStorage.getItem(CACHE_KEY+":"+currentWsId)); }catch(__){}
    data=normalizeData(cached);
  }
}

/* ---------------- View modes (edit / aggregate / overview) ---------------- */
function setView(mode){
  viewMode=mode;
  document.getElementById("editMain").style.display      = mode==="edit"      ? "" : "none";
  document.getElementById("aggregateView").style.display = mode==="aggregate" ? "" : "none";
  document.getElementById("overviewView").style.display  = mode==="overview"  ? "" : "none";
  document.getElementById("reportBtn").style.display     = mode==="edit"      ? "" : "none";
}
/* The "👥 メンバー状況" button shows only for a team you administer, in edit mode. */
function updateModeButtons(){
  const cur=curWs();
  const isTeamAdmin = !!cur && cur.kind==="team" && (cur.role==="admin"||cur.role==="owner");
  document.getElementById("overviewBtn").style.display = (viewMode==="edit" && isTeamAdmin) ? "" : "none";
}
/* Re-render whatever view is active (used when the date changes). */
function rerender(){
  if(viewMode==="aggregate") renderAggregate();
  else if(viewMode==="overview") renderOverview();
  else render();
}

/* ---- read-only helpers shared by aggregate + overview ---- */
function dayTasks(d, date){
  const t = d && d.tickets && d.tickets[date];
  return (t && Array.isArray(t.tasks)) ? t.tasks : [];
}
function dayStats(d, date){
  let total=0, done=0;
  (function walk(arr){ (arr||[]).forEach(x=>{ total++; if(x.done) done++; walk(x.children); }); })(dayTasks(d,date));
  return { total, done };
}
function roAppendTasks(ul, tasks, depth){
  (tasks||[]).forEach(t=>{
    const li=el("li",{class:"ro-task"+(t.done?" done":"")+(t.prio==="semi"?" semi":"")},
      el("span",{class:"ro-check", text:t.done?"☑":"☐"}),
      el("span",{class:"ro-text", text:t.text||"（無題）"}),
      (t.prio==="semi") ? el("span",{class:"ro-prio", text:"準"}) : null,
      t.est ? el("span",{class:"ro-est", text:t.est+"h"}) : null
    );
    li.style.paddingLeft=(10+(depth||0)*16)+"px";
    ul.appendChild(li);
    if(t.comment && String(t.comment).trim()){
      const memo=el("li",{class:"ro-memo", text:"💬 "+String(t.comment).trim()});
      memo.style.paddingLeft=(28+(depth||0)*16)+"px";
      ul.appendChild(memo);
    }
    if(Array.isArray(t.children) && t.children.length) roAppendTasks(ul, t.children, (depth||0)+1);
  });
}

/* ---- richer per-member metrics for the overview ---- */
function dayHours(d, date){
  let est=0, doneEst=0;
  (function walk(arr){ (arr||[]).forEach(x=>{ const h=parseFloat(x.est)||0; est+=h; if(x.done) doneEst+=h; walk(x.children); }); })(dayTasks(d,date));
  return { est:Math.round(est*10)/10, doneEst:Math.round(doneEst*10)/10 };
}
function dayPrio(d, date){
  let top=0, topDone=0, semi=0, semiDone=0;
  (function walk(arr){ (arr||[]).forEach(x=>{
    if(x.prio==="semi"){ semi++; if(x.done) semiDone++; } else { top++; if(x.done) topDone++; }
    walk(x.children);
  }); })(dayTasks(d,date));
  return { top, topDone, semi, semiDone };
}
function acStats(d){
  const ac=Array.isArray(d.ac)?d.ac:[];
  return { total:ac.length, done:ac.filter(x=>x && x.done).length };
}
/* the n calendar days ending at `date` (oldest → newest) */
function recentDays(date, n){
  const out=[], base=new Date(date+"T00:00:00");
  for(let i=n-1;i>=0;i--){ const dt=new Date(base); dt.setDate(dt.getDate()-i); out.push(isoOf(dt)); }
  return out;
}
/* "たった今 / x分前 / x時間前 / x日前 / M/D" */
function relTime(ts){
  if(!ts) return "未更新";
  const t=new Date(ts).getTime(); if(isNaN(t)) return "—";
  const s=Math.max(0,(Date.now()-t)/1000);
  if(s<60) return "たった今";
  if(s<3600) return Math.floor(s/60)+"分前";
  if(s<86400) return Math.floor(s/3600)+"時間前";
  if(s<86400*7) return Math.floor(s/86400)+"日前";
  const d=new Date(ts); return (d.getMonth()+1)+"/"+d.getDate();
}

/* ---- 全体混合: my own TD across every workspace, read-only ---- */
async function openAggregate(){
  if(currentWsId===AGG_ID && viewMode==="aggregate"){ closeDrawer(); return; }
  await flushSave();
  currentWsId=AGG_ID;
  try{ localStorage.setItem("ayanu.lastWs", AGG_ID); }catch(_){}
  try{ aggData=await api("/aggregate"); }catch(_){ aggData={workspaces:[]}; }
  setView("aggregate"); updateModeButtons(); closeDrawer();
  currentDate=todayStr(); calYM=currentDate.slice(0,7);
  renderAggregate();
}
function renderAggregate(){
  renderWorkspaces();
  const root=document.getElementById("aggregateView"); root.innerHTML="";
  root.appendChild(el("div",{class:"ro-head"},
    el("h2",{text:"📋 全体混合"}),
    el("span",{class:"ro-sub", text:fmtDate(currentDate)+" の自分のTD（全ワークスペース）"})
  ));
  let any=false;
  ((aggData&&aggData.workspaces)||[]).forEach(w=>{
    const d=normalizeData(w.data);
    const tasks=dayTasks(d,currentDate);
    if(!tasks.length) return;
    any=true;
    const st=dayStats(d,currentDate);
    const ul=el("ul",{class:"ro-tasks"}); roAppendTasks(ul, tasks, 0);
    root.appendChild(el("div",{class:"ro-card"},
      el("div",{class:"ro-card-head"},
        el("span",{class:"ro-ws-name", text:w.name}),
        el("span",{class:"ro-badge "+w.kind, text: w.kind==="team"?"チーム":"個人"}),
        el("span",{class:"ro-prog", text: st.done+"/"+st.total})
      ), ul));
  });
  if(!any) root.appendChild(el("div",{class:"ro-empty", text:"この日のタスクはありません。"}));
}

/* ---- メンバー状況: team admin oversight dashboard, read-only ---- */
async function openOverview(){
  if(!currentWsId || currentWsId===AGG_ID) return;
  await flushSave();
  try{ overviewData=await api("/workspaces/"+currentWsId+"/overview"); }
  catch(e){ alert(e.message); return; }
  setView("overview"); updateModeButtons();
  renderOverview();
}
function ovStat(label, val, accent){
  return el("div",{class:"ov-stat"+(accent?" accent":"")},
    el("div",{class:"ov-stat-val", text:val}),
    el("div",{class:"ov-stat-lbl", text:label})
  );
}
function ovChip(label, val, cls){
  return el("span",{class:"ov-chip"+(cls?" "+cls:"")}, el("b",{text:val}), el("span",{class:"ov-chip-lbl", text:label}));
}
function renderOverview(){
  renderWorkspaces();
  const root=document.getElementById("overviewView"); root.innerHTML="";
  const members=(overviewData&&overviewData.members)||[];

  root.appendChild(el("div",{class:"ro-head"},
    el("button",{class:"btn", text:"← 自分のTDに戻る", onClick:backToEdit}),
    el("h2",{text:"👥 メンバー状況"}),
    el("span",{class:"ro-sub", text:fmtDate(currentDate)+" の進捗"})
  ));

  // team-wide summary
  let mWith=0, tTot=0, tDone=0;
  members.forEach(m=>{ const st=dayStats(normalizeData(m.data),currentDate); if(st.total){ mWith++; tTot+=st.total; tDone+=st.done; } });
  const teamPct = tTot ? Math.round(tDone/tTot*100) : 0;
  root.appendChild(el("div",{class:"ov-summary"},
    ovStat("メンバー", members.length+"人"),
    ovStat("本日記入", mWith+"/"+members.length+"人"),
    ovStat("タスク完了", tDone+"/"+tTot),
    ovStat("完了率", teamPct+"%", true)
  ));

  members.forEach(m=>{
    const d=normalizeData(m.data);
    const st=dayStats(d,currentDate);
    const pct = st.total ? Math.round(st.done/st.total*100) : 0;
    const hrs=dayHours(d,currentDate);
    const pr=dayPrio(d,currentDate);
    const ac=acStats(d);
    const tasks=dayTasks(d,currentDate);
    const noEntry = st.total===0;

    const card=el("div",{class:"ov-card"+(noEntry?" empty":"")});

    // ---- header: avatar, name, role + last-updated, today's progress, caret ----
    const caret=el("span",{class:"ov-caret", text:"▸"});
    const head=el("div",{class:"ov-head"},
      el("span",{class:"ov-avatar", text:((m.username||m.email||"U").trim()[0]||"U").toUpperCase()}),
      el("div",{class:"ov-id"},
        el("span",{class:"ov-name", text:(m.username||m.email)}),
        el("span",{class:"ov-meta", text:roleLabel(m.role)+" ・ 更新 "+relTime(m.updated_at)})
      ),
      el("span",{class:"ov-prog", text: noEntry ? "未記入" : st.done+"/"+st.total+"（"+pct+"%）"}),
      caret
    );

    // ---- today's progress bar ----
    const fill=el("div",{class:"ov-bar-fill"+((pct===100&&st.total)?" done":"")}); fill.style.width=pct+"%";
    const bar=el("div",{class:"ov-bar"}, fill);

    // ---- stat chips: 優 / 準 / time / AfterCheck ----
    const chips=el("div",{class:"ov-chips"},
      ovChip("優先", pr.topDone+"/"+pr.top, "top"),
      ovChip("準", pr.semiDone+"/"+pr.semi, "semi"),
      ovChip("時間", hrs.doneEst+"/"+hrs.est+"h"),
      ovChip("AfterCheck", ac.done+"/"+ac.total)
    );

    // ---- expandable detail: 7-day trend + task list (with memos) + AfterCheck ----
    const detail=el("div",{class:"ov-detail"}); detail.style.display="none";

    const trend=el("div",{class:"ov-trend"});
    recentDays(currentDate,7).forEach(ds=>{
      const s=dayStats(d,ds), p=s.total?Math.round(s.done/s.total*100):0;
      const cell=el("div",{class:"ov-tr-cell"+(ds===currentDate?" cur":"")+(s.total?"":" empty"), title:fmtDate(ds)+"  "+s.done+"/"+s.total});
      const f=el("div",{class:"ov-tr-fill"}); f.style.height=(s.total?Math.max(10,p):0)+"%";
      cell.appendChild(f);
      cell.appendChild(el("span",{class:"ov-tr-lbl", text:ds.slice(8)}));
      trend.appendChild(cell);
    });
    detail.appendChild(el("div",{class:"ov-detail-title", text:"直近7日"}));
    detail.appendChild(trend);

    detail.appendChild(el("div",{class:"ov-detail-title", text:"ToDo（"+fmtDate(currentDate)+"）"}));
    if(tasks.length){ const ul=el("ul",{class:"ro-tasks"}); roAppendTasks(ul, tasks, 0); detail.appendChild(ul); }
    else detail.appendChild(el("div",{class:"ro-empty", text:"この日のタスクはありません。"}));

    if(ac.total){
      detail.appendChild(el("div",{class:"ov-detail-title", text:"AfterCheck"}));
      const aul=el("ul",{class:"ro-tasks"});
      (d.ac||[]).forEach(x=> aul.appendChild(el("li",{class:"ro-task"+(x&&x.done?" done":"")},
        el("span",{class:"ro-check", text:(x&&x.done)?"☑":"☐"}),
        el("span",{class:"ro-text", text:(x&&x.text)||"（無題）"})
      )));
      detail.appendChild(aul);
    }

    head.onclick=()=>{ const open=detail.style.display==="none"; detail.style.display=open?"":"none"; caret.classList.toggle("open",open); };
    card.append(head, bar, chips, detail);
    root.appendChild(card);
  });

  if(!members.length) root.appendChild(el("div",{class:"ro-empty", text:"メンバーがいません。"}));
}
function backToEdit(){
  // `data` is untouched while viewing the dashboard, so just re-render it instantly
  setView("edit"); updateModeButtons();
  renderClean(); setSyncStatus("saved");
}
document.getElementById("overviewBtn").onclick=openOverview;

/* create a new workspace */
async function createWorkspace(){
  const name=prompt("ワークスペース名"); if(!name || !name.trim()) return;
  const kind=confirm("チーム用（共有を前提）にしますか？\n\nOK＝チーム　/　キャンセル＝個人") ? "team" : "personal";
  try{
    const w=await api("/workspaces",{method:"POST",body:{name:name.trim(), kind}});
    await refreshWorkspaces();
    await selectWorkspace(w.id);
  }catch(e){ alert(e.message); }
}
document.getElementById("addWs").onclick=createWorkspace;
document.getElementById("shareWsBtn").onclick=()=>openShare();

/* pick a workspace after leaving/deleting one (create a default if none left) */
async function repickWorkspace(){
  await refreshWorkspaces();
  if(!wsList.length){
    try{ const w=await api("/workspaces",{method:"POST",body:{name:"マイワークスペース",kind:"personal"}}); wsList=[w]; }catch(_){}
  }
  currentWsId = wsList[0] && wsList[0].id;
  try{ localStorage.setItem("ayanu.lastWs", currentWsId); }catch(_){}
  await loadWorkspaceData();
  currentDate=todayStr(); calYM=currentDate.slice(0,7);
  render();
}

/* ---------------- Share / members modal ---------------- */
function inviteUrl(token, type){ return location.origin+location.pathname+"?"+type+"="+token; }
function openShareOverlay(){ document.getElementById("shareOverlay").classList.add("open"); }
function closeShare(){ document.getElementById("shareOverlay").classList.remove("open"); }

async function openShare(id){
  const wsId = id || currentWsId;
  if(!wsId) return;
  closeDrawer();
  try{ renderShare(await api("/workspaces/"+wsId)); openShareOverlay(); }
  catch(e){ alert(e.message); }
}
async function reopenShare(id){
  try{ renderShare(await api("/workspaces/"+id)); await refreshWorkspaces(); }
  catch(e){ alert(e.message); }
}

function renderShare(d){
  const isAdmin = d.myRole==="admin" || d.myRole==="owner";
  const isOwner = d.myRole==="owner";
  const card=document.getElementById("shareCard");
  card.innerHTML="";

  card.appendChild(el("div",{class:"share-head"},
    el("strong",{text:d.name}),
    el("span",{class:"ws-role", text:roleLabel(d.myRole)}),
    el("button",{class:"icon-btn", text:"✕", title:"閉じる", onClick:closeShare})
  ));

  if(isAdmin){
    const nameInput=el("input",{class:"share-input", value:d.name});
    card.appendChild(el("div",{class:"share-row"},
      nameInput,
      el("button",{class:"mini-btn", text:"名前変更", onClick:async()=>{
        try{ await api("/workspaces/"+d.id,{method:"PATCH",body:{name:nameInput.value}}); await reopenShare(d.id); }
        catch(e){ alert(e.message); } }})
    ));
  }

  // members
  card.appendChild(el("div",{class:"share-section-title", text:"メンバー（"+d.members.length+"）"}));
  d.members.forEach(m=>{
    const isSelf = m.email.toLowerCase()===currentUserEmail.toLowerCase();
    const row=el("div",{class:"member-row"},
      el("span",{class:"member-email", text:m.email + (isSelf?"（あなた）":"")}));
    if(isAdmin && m.role!=="owner"){
      const sel=el("select",{class:"role-select", onChange:async(e)=>{
        try{ await api("/workspaces/"+d.id+"/members/"+m.id,{method:"PATCH",body:{role:e.target.value}}); await reopenShare(d.id); }
        catch(err){ alert(err.message); } }},
        el("option",{value:"member", ...(m.role==="member"?{selected:"selected"}:{})},"メンバー"),
        el("option",{value:"admin", ...(m.role==="admin"?{selected:"selected"}:{})},"管理者"),
        isOwner ? el("option",{value:"owner"},"オーナーに譲渡") : null
      );
      row.appendChild(sel);
      row.appendChild(el("button",{class:"mini-btn danger", text:"削除", onClick:async()=>{
        if(!confirm(m.email+" を削除しますか？")) return;
        try{ await api("/workspaces/"+d.id+"/members/"+m.id,{method:"DELETE"}); await reopenShare(d.id); }
        catch(e){ alert(e.message); } }}));
    } else {
      row.appendChild(el("span",{class:"ws-role", text:roleLabel(m.role)}));
    }
    card.appendChild(row);
  });

  if(!isOwner){
    card.appendChild(el("button",{class:"mini-btn block", text:"このワークスペースから退出", onClick:async()=>{
      if(!confirm("退出しますか？")) return;
      const me=d.members.find(m=>m.email.toLowerCase()===currentUserEmail.toLowerCase());
      try{ await api("/workspaces/"+d.id+"/members/"+me.id,{method:"DELETE"}); closeShare(); await repickWorkspace(); }
      catch(e){ alert(e.message); } }}));
  }

  if(isAdmin){
    // email invite
    card.appendChild(el("div",{class:"share-section-title", text:"メールで招待"}));
    const mail=el("input",{class:"share-input", type:"email", placeholder:"メールアドレス"});
    const mailRole=el("select",{class:"role-select"}, el("option",{value:"member"},"メンバー"), el("option",{value:"admin"},"管理者"));
    card.appendChild(el("div",{class:"share-row"},
      mail, mailRole,
      el("button",{class:"mini-btn primary", text:"招待", onClick:async()=>{
        try{ const r=await api("/workspaces/"+d.id+"/invites",{method:"POST",body:{email:mail.value, role:mailRole.value}});
          await reopenShare(d.id);
          if(r.emailSent){ alert("招待メールを送信しました：" + r.email); }
          else{ prompt("メール送信は未設定です。このリンクを相手に送ってください（相手は同じメールでログイン/登録して参加）", inviteUrl(r.token,"invite")); }
        }catch(e){ alert(e.message); } }})
    ));
    if(d.invites.length){
      card.appendChild(el("div",{class:"share-sub", text:"保留中の招待"}));
      d.invites.forEach(i=> card.appendChild(el("div",{class:"member-row"},
        el("span",{class:"member-email", text:i.email}),
        el("span",{class:"ws-role", text:roleLabel(i.role)}),
        el("button",{class:"mini-btn", text:"リンク", onClick:()=>prompt("招待リンク", inviteUrl(i.token,"invite"))}),
        el("button",{class:"mini-btn danger", text:"取消", onClick:async()=>{
          try{ await api("/workspaces/"+d.id+"/invites/"+i.id,{method:"DELETE"}); await reopenShare(d.id); }
          catch(e){ alert(e.message); } }})
      )));
    }

    // invite link
    card.appendChild(el("div",{class:"share-section-title", text:"招待リンク"}));
    if(d.inviteToken){
      const url=inviteUrl(d.inviteToken,"join");
      card.appendChild(el("div",{class:"share-row"},
        el("input",{class:"share-input", value:url, readonly:"readonly", onClick:(e)=>e.target.select()}),
        el("button",{class:"mini-btn", text:"コピー", onClick:()=>{ try{ navigator.clipboard.writeText(url); }catch(_){ } }}),
        el("button",{class:"mini-btn danger", text:"無効化", onClick:async()=>{
          try{ await api("/workspaces/"+d.id+"/invite-link",{method:"DELETE"}); await reopenShare(d.id); }
          catch(e){ alert(e.message); } }})
      ));
      card.appendChild(el("div",{class:"share-sub", text:"開いた人は「"+roleLabel(d.inviteRole)+"」として参加します"}));
    } else {
      const linkRole=el("select",{class:"role-select"}, el("option",{value:"member"},"メンバー"), el("option",{value:"admin"},"管理者"));
      card.appendChild(el("div",{class:"share-row"},
        linkRole,
        el("button",{class:"mini-btn primary", text:"リンクを作成", onClick:async()=>{
          try{ await api("/workspaces/"+d.id+"/invite-link",{method:"POST",body:{role:linkRole.value}}); await reopenShare(d.id); }
          catch(e){ alert(e.message); } }})
      ));
    }
  }

  if(isOwner){
    card.appendChild(el("hr",{class:"share-hr"}));
    card.appendChild(el("button",{class:"mini-btn danger block", text:"ワークスペースを削除", onClick:async()=>{
      if(!confirm("『"+d.name+"』を削除しますか？すべての日報・メンバーが削除されます。")) return;
      try{ await api("/workspaces/"+d.id,{method:"DELETE"}); closeShare(); await repickWorkspace(); }
      catch(e){ alert(e.message); } }}));
  }
}

/* ---------------- Account settings ---------------- */
let accountCache=null;   // last-known account info (primed at login) for instant modal open
function closeAccount(){ document.getElementById("accountOverlay").classList.remove("open"); }
async function openAccount(){
  const ov=document.getElementById("accountOverlay");
  if(accountCache){ renderAccount(accountCache); ov.classList.add("open"); }   // instant from cache
  try{ const a=await api("/account"); accountCache=a; renderAccount(a); ov.classList.add("open"); }
  catch(e){ if(!accountCache) alert("アカウント情報の取得に失敗しました: "+e.message); }
}
function renderAccount(a){
  const card=document.getElementById("accountCard");
  card.innerHTML="";
  const notif = a.notifications || {};
  const handleSet = !!a.handle;

  const emailInput  = el("input",{type:"email", class:"share-input", value:a.email||""});
  const nameInput   = el("input",{type:"text",  class:"share-input", value:a.username||"", maxlength:"50", placeholder:"表示名"});
  const handleInput = el("input",{type:"text",  class:"share-input", value:a.handle||"", placeholder:"半角英数字・_ 3〜20文字"});
  if(handleSet) handleInput.disabled=true;
  const cbInvites = el("input",{type:"checkbox"}); cbInvites.checked = notif.emailInvites !== false;
  const cbUpdates = el("input",{type:"checkbox"}); cbUpdates.checked = !!notif.emailUpdates;

  const err = el("div",{class:"auth-error"});
  const saveBtn = el("button",{class:"btn btn-primary", text:"保存"});
  saveBtn.onclick=async ()=>{
    err.textContent=""; saveBtn.disabled=true;
    const payload={
      email: emailInput.value.trim(),
      username: nameInput.value.trim(),
      notifications: { emailInvites: cbInvites.checked, emailUpdates: cbUpdates.checked },
    };
    if(!handleSet) payload.handle = handleInput.value.trim();
    try{
      const r=await api("/account",{method:"PATCH",body:payload});
      accountCache=r;
      currentUserEmail=r.email;
      setUserIdentity(r.username || r.email);
      renderAccount(r);   // re-render (handle now locked, fields normalized)
    }catch(e){ err.textContent=e.message; }
    finally{ saveBtn.disabled=false; }
  };

  card.append(
    el("div",{class:"share-head"},
      el("strong",{text:"アカウント設定"}),
      el("button",{class:"icon-btn", text:"✕", title:"閉じる", onClick:closeAccount})),
    el("div",{class:"acc-field"}, el("label",{text:"メールアドレス"}), emailInput),
    el("div",{class:"acc-field"}, el("label",{text:"ユーザーネーム"}), nameInput),
    el("div",{class:"acc-field"},
      el("label",{text:"ユーザーID"+(handleSet?"（変更不可）":"（設定後は変更できません）")}),
      handleInput),
    el("div",{class:"share-section-title", text:"通知設定"}),
    el("label",{class:"acc-check"}, cbInvites, el("span",{text:"ワークスペースへの招待メールを受け取る"})),
    el("label",{class:"acc-check"}, cbUpdates, el("span",{text:"お知らせ・更新のメールを受け取る"})),
    err,
    el("div",{class:"acc-actions"}, saveBtn)
  );
}
/* ---- user menu (top-right dropdown: account / logout) ---- */
const userMenuBtn=document.getElementById("userMenuBtn");
const userDropdown=document.getElementById("userDropdown");
function closeUserMenu(){ userDropdown.classList.remove("open"); document.removeEventListener("mousedown",_userOutside,true); }
function _userOutside(e){ if(!userDropdown.contains(e.target) && !userMenuBtn.contains(e.target)) closeUserMenu(); }
userMenuBtn.onclick=()=>{
  const open=userDropdown.classList.toggle("open");
  if(open) setTimeout(()=>document.addEventListener("mousedown",_userOutside,true),0);
  else closeUserMenu();
};
document.getElementById("accountBtn").onclick=()=>{ closeUserMenu(); openAccount(); };
/* set the header user label + avatar initial */
function setUserIdentity(name){
  const n=(name||currentUserEmail||"").trim();
  document.getElementById("userEmail").textContent=n;
  const av=document.getElementById("userAvatar");
  if(av) av.textContent=(n[0]||"U").toUpperCase();
}

/* ---- mobile sidebar (persistent on desktop; slide-over on small screens) ---- */
const sidebarEl=document.getElementById("sidebar");
const sidebarOverlayEl=document.getElementById("sidebarOverlay");
function openDrawer(){ sidebarEl.classList.add("open"); sidebarOverlayEl.classList.add("open"); }
function closeDrawer(){ sidebarEl.classList.remove("open"); sidebarOverlayEl.classList.remove("open"); }
document.getElementById("navToggle").onclick=()=> sidebarEl.classList.contains("open") ? closeDrawer() : openDrawer();
sidebarOverlayEl.onclick=closeDrawer;
document.addEventListener("keydown",e=>{ if(e.key==="Escape"){ closeDrawer(); closeUserMenu(); } });

const WD = ["日","月","火","水","木","金","土"];
function fmtDate(ds){
  const d=new Date(ds+"T00:00:00");
  return (d.getMonth()+1)+"/"+d.getDate()+"（"+WD[d.getDay()]+"）";
}

/* Sidebar: recent dates (most recent first), always including today & the current view. */
function renderDayList(){
  const el=document.getElementById("dayList");
  const today=todayStr();
  const allTickets=ws().tickets;
  const dates=new Set(Object.keys(allTickets));
  dates.add(currentDate);
  // always include the last 7 days (today and the previous 6), even if empty
  for(let i=0;i<7;i++){
    const d=new Date(today+"T00:00:00"); d.setDate(d.getDate()-i);
    const off=d.getTimezoneOffset();
    dates.add(new Date(d.getTime()-off*60000).toISOString().slice(0,10));
  }
  const sorted=[...dates].sort().reverse().slice(0,14);   // newest first, cap at 14

  el.innerHTML="";
  sorted.forEach(ds=>{
    const t=allTickets[ds];
    let total=0, done=0;
    // progress counts only 優 (top) priority tasks; 準 (semi) is excluded
    if(t){ const walk=arr=>arr.forEach(x=>{ if(x.prio!=="semi"){ total++; if(x.done)done++; } walk(x.children); }); walk(t.tasks); }
    const li=document.createElement("li");
    if(ds===currentDate) li.className="active";
    li.onclick=()=>{ currentDate=ds; calYM=ds.slice(0,7); render(); };
    const d=document.createElement("span"); d.className="d-date"; d.textContent=fmtDate(ds);
    li.appendChild(d);
    if(ds===today){ const b=document.createElement("span"); b.className="d-today"; b.textContent="今日"; li.appendChild(b); }
    const m=document.createElement("span"); m.className="d-meta";
    m.textContent = total ? done+"/"+total : "—";
    li.appendChild(m);
    el.appendChild(li);
  });
}

/* Priority is always one of two levels: 優 (top) / 準 (semi). */
function prioLabel(p){ return p==="semi" ? "準" : "優"; }

function buildTaskItem(t, depth){
  const li = document.createElement("li");
  li.className = "task";
  li.dataset.id = t.id;

  const row = document.createElement("div");
  row.className = "task-row" + (t.done ? " done":"") + (t.prio==="semi" ? " semi":"");
  row.dataset.id = t.id;

  // drag handle (grab the left end to reorder AND change hierarchy)
  const handle = document.createElement("span");
  handle.className="handle"; handle.textContent="⠿";
  handle.title="掴んでドラッグ：上下で並び替え／右に寄せると子タスクに";
  row.appendChild(handle);

  // checkbox
  const cb = document.createElement("input");
  cb.type="checkbox"; cb.checked=t.done;
  cb.onchange = ()=>{ t.done=cb.checked; render(); };
  row.appendChild(cb);

  // text (textarea: Shift+Enter = newline, Enter = next row)
  const text = document.createElement("textarea");
  text.className="task-text"; text.rows=1; text.value=t.text; text.placeholder="タスク名…";
  text.oninput = ()=>{ t.text=text.value; autoGrow(text); save(); };
  text.addEventListener("keydown", e=>{
    if(e.isComposing) return;   // ignore Enter/Tab while confirming IME conversion
    if(e.key==="Tab"){ e.preventDefault(); e.shiftKey ? outdentTask(t) : indentTask(t); }
    else if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); addSiblingAfter(t); }
  });
  row.appendChild(text);

  // estimate
  const est = document.createElement("input");
  est.className="est"; est.type="number"; est.min="0"; est.step="0.5";
  est.value=t.est; est.placeholder="0"; est.title="見積もり時間";
  est.oninput = ()=>{ t.est=est.value; save(); updateSummaries(); };
  row.appendChild(est);
  const unit=document.createElement("span"); unit.className="est-unit"; unit.textContent="h"; row.appendChild(unit);

  // priority (two levels: 優 / 準, default 優)
  if(t.prio!=="top" && t.prio!=="semi") t.prio="top";   // normalize legacy/empty values
  const prio = document.createElement("button");
  prio.className="prio-btn "+t.prio;
  prio.textContent=prioLabel(t.prio);
  prio.title="クリックで 優 ⇄ 準 を切り替え";
  prio.onclick = ()=>{ t.prio = t.prio==="top" ? "semi" : "top"; render(); };
  row.appendChild(prio);

  // comment toggle
  const cBtn=document.createElement("button");
  cBtn.className="icon-btn"+((t.comment||t.showComment)?" active":"");
  cBtn.textContent="💬"; cBtn.title="コメント";
  cBtn.onclick=()=>{ t.showComment=!t.showComment; render(); };
  row.appendChild(cBtn);

  // hierarchy is changed via Tab/Shift+Tab or by dragging the handle (no inline arrows)

  // add child (only allow one level of nesting -> parents only)
  if(depth===0){
    const addChild=document.createElement("button");
    addChild.className="icon-btn"; addChild.textContent="＋"; addChild.title="子タスクを追加";
    addChild.onclick=()=>{ t.children.push(newTask("")); t.showChildren=true; render(); };
    row.appendChild(addChild);
  } else {
    // child rows: reserve the ＋ slot so trailing columns stay aligned with parents
    const spacer=document.createElement("span");
    spacer.className="icon-btn"; spacer.style.visibility="hidden"; spacer.textContent="＋";
    row.appendChild(spacer);
  }

  // kebab menu: copy / delete
  const more=document.createElement("button");
  more.className="icon-btn"; more.textContent="⋯"; more.title="その他";
  more.onclick=()=>openMenu(more,[
    {label:"複製", icon:"⧉", onClick:()=>{ const f=findTask(t.id); if(f){ f.list.splice(f.list.indexOf(t)+1,0,cloneTask(t)); render(); } }},
    {sep:true},
    {label:"削除", icon:"🗑", danger:true, onClick:()=>{ const f=findTask(t.id); if(f){ f.list.splice(f.list.indexOf(t),1); render(); } }},
  ]);
  row.appendChild(more);

  setupDrag(row, handle, t);
  li.appendChild(row);

  // comment box
  if(t.showComment){
    const box=document.createElement("div"); box.className="comment";
    const ta=document.createElement("textarea");
    ta.value=t.comment; ta.placeholder="メモ・進捗・補足…";
    ta.oninput=()=>{ t.comment=ta.value; save(); };
    box.appendChild(ta); li.appendChild(box);
  }

  // children
  if(depth===0 && t.children.length){
    const sub=document.createElement("ul"); sub.className="subtasks";
    t.children.forEach(c=> sub.appendChild(buildTaskItem(c,1)));
    li.appendChild(sub);
  }
  return li;
}

function renderTasks(){
  const tasks = ticket().tasks;
  taskListEl.innerHTML="";
  if(!tasks.length){
    taskListEl.innerHTML='<li class="empty">タスクがありません。下から追加してください。</li>';
  } else {
    tasks.forEach(t=> taskListEl.appendChild(buildTaskItem(t,0)));
    taskListEl.querySelectorAll(".task-text").forEach(autoGrow);   // size multiline rows
  }
  updateSummaries();
}

/* Resize a textarea to fit its content. */
function autoGrow(ta){ ta.style.height="auto"; ta.style.height=ta.scrollHeight+"px"; }

/* Add a new AfterCheck item after the given index (or at the end). */
function addTodoAfter(idx){
  const todos=acList();
  const n=newTodo("");
  todos.splice(idx+1,0,n);
  render();
  const el=document.querySelector('.todo[data-id="'+n.id+'"] .todo-text');
  if(el) el.focus();
}

function renderTodos(){
  const todos = acList();
  todoListEl.innerHTML="";
  if(!todos.length){
    todoListEl.innerHTML='<li class="empty">項目がありません。</li>';
  } else {
    todos.forEach((td,idx)=>{
      const li=document.createElement("li");
      li.className="todo"+(td.done?" done":"");
      li.dataset.id=td.id;
      const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=td.done;
      cb.onchange=()=>{ td.done=cb.checked; render(); };
      const text=document.createElement("textarea");
      text.className="todo-text"; text.rows=1; text.value=td.text; text.placeholder="項目…";
      text.oninput=()=>{ td.text=text.value; autoGrow(text); save(); };
      // Enter = next item, Shift+Enter = newline within this item
      text.addEventListener("keydown",e=>{
        if(e.isComposing) return;   // ignore Enter while confirming IME conversion
        if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); addTodoAfter(idx); }
      });
      const more=document.createElement("button");
      more.className="icon-btn"; more.textContent="⋯"; more.title="その他";
      more.onclick=()=>openMenu(more,[
        {label:"複製", icon:"⧉", onClick:()=>{ todos.splice(todos.indexOf(td)+1,0,cloneTodo(td)); render(); }},
        {sep:true},
        {label:"削除", icon:"🗑", danger:true, onClick:()=>{ todos.splice(todos.indexOf(td),1); render(); }},
      ]);
      li.append(cb,text,more);
      todoListEl.appendChild(li);
      autoGrow(text);
    });
  }
  updateSummaries();
}

function updateSummaries(){
  const tasks=ticket().tasks;
  let total=0, done=0, hours=0;
  const walk=arr=>arr.forEach(t=>{ total++; if(t.done)done++; hours+=parseFloat(t.est)||0; walk(t.children); });
  walk(tasks);
  document.getElementById("leftSummary").textContent =
    total? `${done}/${total} 完了 ・ 計 ${hours}h` : "";
}

/* ---------------- Drag & drop: reorder + hierarchy ---------------- */
let dragId=null, dropPlan=null;
function clearDropIndicators(){
  document.querySelectorAll(".di-before,.di-after,.di-child")
    .forEach(r=>r.classList.remove("di-before","di-after","di-child"));
}

/* Move a task to a new position. mode: 'before' | 'after' | 'child' (relative to target).
   Respects the 2-level limit; falls back to a valid sibling position when nesting is impossible. */
function moveTask(srcId, targetId, mode){
  if(!srcId || srcId===targetId) return;
  const from=findTask(srcId); if(!from) return;
  const src=from.task;
  const tref=findTask(targetId); if(!tref) return;
  const target=tref.task;
  if(src.children && src.children.includes(target)) return;   // can't move a parent around its own child
  const srcHasKids = src.children.length>0;

  from.list.splice(from.list.indexOf(src),1);                 // detach
  const tasks=ticket().tasks;
  const tgtParent=findParent(target);                         // null => target is top-level

  if(mode==="child"){
    if(tgtParent===null && !srcHasKids){ target.children.push(src); }
    else if(tgtParent===null){ tasks.splice(tasks.indexOf(target)+1,0,src); }      // src has kids → can't nest
    else if(!srcHasKids){ tgtParent.children.splice(tgtParent.children.indexOf(target)+1,0,src); }
    else { tasks.splice(tasks.indexOf(tgtParent)+1,0,src); }
  } else {
    const after = mode==="after";
    if(tgtParent===null){ let i=tasks.indexOf(target); if(after)i++; tasks.splice(i,0,src); }
    else if(!srcHasKids){ let i=tgtParent.children.indexOf(target); if(after)i++; tgtParent.children.splice(i,0,src); }
    else { let i=tasks.indexOf(tgtParent); if(after)i++; tasks.splice(i,0,src); } // src has kids → top level
  }
  render(); focusTask(src.id);
}

function setupDrag(row, handle, task){
  handle.draggable=true;
  handle.addEventListener("dragstart", e=>{
    dragId=task.id; e.dataTransfer.effectAllowed="move";
    try{ e.dataTransfer.setData("text/plain", task.id); }catch(_){}
    try{ e.dataTransfer.setDragImage(row, 12, 14); }catch(_){}
  });
  handle.addEventListener("dragend", ()=>{ dragId=null; dropPlan=null; clearDropIndicators(); });

  row.addEventListener("dragover", e=>{
    if(!dragId || dragId===task.id) return;
    e.preventDefault();
    const rect=row.getBoundingClientRect();
    const relX=(e.clientX-rect.left)/rect.width;
    const relY=(e.clientY-rect.top)/rect.height;
    const targetIsTop = !findParent(task);
    let mode;
    if(targetIsTop && relX>0.30) mode="child";          // drag toward the right → nest as child
    else mode = relY<0.5 ? "before" : "after";
    clearDropIndicators();
    row.classList.add(mode==="child" ? "di-child" : mode==="before" ? "di-before" : "di-after");
    dropPlan={targetId:task.id, mode};
  });
  row.addEventListener("drop", e=>{
    e.preventDefault();
    const p=dropPlan; clearDropIndicators();
    if(dragId && p) moveTask(dragId, p.targetId, p.mode);
    dragId=null; dropPlan=null;
  });
}

/* ---------------- Add handlers ---------------- */
function addTaskFromInput(asChild){
  const i=document.getElementById("newTask");
  const v=i.value.trim(); if(!v)return;
  const tasks=ticket().tasks;
  if(asChild && tasks.length){
    // Tab → nest under the last top-level task
    tasks[tasks.length-1].children.push(newTask(v));
  } else {
    tasks.push(newTask(v));
  }
  i.value=""; render(); i.focus();
}
function addTodoFromInput(){
  const i=document.getElementById("newTodo");
  const v=i.value.trim(); if(!v)return;
  acList().push(newTodo(v)); i.value=""; autoGrow(i); render(); i.focus();
}
document.getElementById("addTask").onclick=()=>addTaskFromInput(false);
document.getElementById("newTask").addEventListener("keydown",e=>{
  if(e.isComposing) return;   // ignore Enter/Tab while confirming IME conversion
  if(e.key==="Enter"){ e.preventDefault(); addTaskFromInput(false); }
  else if(e.key==="Tab"){ e.preventDefault(); addTaskFromInput(true); }   // Tab → 子タスクとして追加
});
const newTodoEl=document.getElementById("newTodo");
document.getElementById("addTodo").onclick=addTodoFromInput;
newTodoEl.addEventListener("input",()=>autoGrow(newTodoEl));
// Enter = 追加, Shift+Enter = 改行
newTodoEl.addEventListener("keydown",e=>{ if(e.isComposing) return; if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); addTodoFromInput(); } });

/* ---------------- Date navigation ---------------- */
function shiftDate(delta){
  const d=new Date(currentDate+"T00:00:00");
  d.setDate(d.getDate()+delta);
  currentDate=isoOf(d); calYM=currentDate.slice(0,7);
  rerender();
}
document.getElementById("prevDay").onclick=()=>shiftDate(-1);
document.getElementById("nextDay").onclick=()=>shiftDate(1);
document.getElementById("todayBtn").onclick=()=>{ currentDate=todayStr(); calYM=currentDate.slice(0,7); rerender(); };

/* ---------------- Auth UI ---------------- */
let authMode="login";   // "login" | "signup"
function showAuth(show){ document.getElementById("authOverlay").style.display = show?"flex":"none"; }
function showApp(show){
  if(show){ setView(viewMode); }
  else{ ["editMain","aggregateView","overviewView"].forEach(id=>{ document.getElementById(id).style.display="none"; }); }
  document.getElementById("userArea").style.display = show?"":"none";
}
function setAuthMode(mode){
  authMode=mode;
  document.getElementById("tabLogin").classList.toggle("active", mode==="login");
  document.getElementById("tabSignup").classList.toggle("active", mode==="signup");
  document.getElementById("authSubmit").textContent = mode==="login" ? "ログイン" : "登録してはじめる";
  document.getElementById("authPassword").setAttribute("autocomplete", mode==="login"?"current-password":"new-password");
  document.getElementById("authError").textContent="";
}
document.getElementById("tabLogin").onclick=()=>setAuthMode("login");
document.getElementById("tabSignup").onclick=()=>setAuthMode("signup");

async function submitAuth(){
  const email=document.getElementById("authEmail").value.trim();
  const password=document.getElementById("authPassword").value;
  const btn=document.getElementById("authSubmit");
  const err=document.getElementById("authError"); err.textContent="";
  btn.disabled=true;
  try{
    const r=await api("/auth/"+authMode, {method:"POST", body:{email, password}});
    currentUserEmail=r.email;
    await afterLogin();
  }catch(e){ err.textContent=e.message; }
  finally{ btn.disabled=false; }
}
document.getElementById("authSubmit").onclick=submitAuth;
document.getElementById("authPassword").addEventListener("keydown",e=>{
  if(e.isComposing) return;
  if(e.key==="Enter"){ e.preventDefault(); submitAuth(); }
});
document.getElementById("logoutBtn").onclick=async ()=>{
  closeUserMenu();
  await flushSave();
  try{ await api("/auth/logout", {method:"POST"}); }catch(_){}
  currentUserEmail=null; currentWsId=null; wsList=[]; pendingInvites=[]; data=emptyData();
  showApp(false); showAuth(true);
};

/* If the page was opened from an invite/join link, consume the token. */
async function processInviteFromURL(){
  const params=new URLSearchParams(location.search);
  const join=params.get("join"), invite=params.get("invite");
  if(!join && !invite) return;
  try{
    const r = join ? await api("/join/"+join, {method:"POST"})
                   : await api("/invites/"+invite+"/accept", {method:"POST"});
    pendingSelectWs=r.workspaceId;
  }catch(e){ alert("招待の処理に失敗しました: "+e.message); }
  history.replaceState({}, "", location.pathname);   // clean the URL
}

function hideBoot(){
  const b=document.getElementById("bootSplash");
  if(!b || b.classList.contains("hide")) return;
  b.classList.add("hide");                       // fade out
  setTimeout(()=>{ b.style.display="none"; }, 360);
}
/* Reveal the fully-rendered app (or login) and drop the boot splash. */
function reveal(){ showAuth(false); showApp(true); hideBoot(); }

async function afterLogin(){
  viewMode="edit";
  setUserIdentity(currentUserEmail);
  try{
    await processInviteFromURL();

    let last=null; try{ last=localStorage.getItem("ayanu.lastWs"); }catch(_){}
    // Fetch account + workspaces in parallel, and optimistically the remembered
    // workspace's data, so the common (returning-user) path is a single round-trip.
    const [acct, , earlyData] = await Promise.all([
      api("/account").catch(()=>null),
      refreshWorkspaces(),
      (last && last!==AGG_ID) ? api("/workspaces/"+last+"/data").then(r=>r.data).catch(()=>null) : Promise.resolve(null),
    ]);
    if(acct){ accountCache=acct; if(acct.username) setUserIdentity(acct.username); }

    if(!wsList.length){
      try{ const w=await api("/workspaces",{method:"POST",body:{name:"マイワークスペース",kind:"personal"}}); wsList=[w]; renderWorkspaces(); }catch(_){}
    }
    if(last===AGG_ID && !pendingSelectWs){ await openAggregate(); return; }   // restore combined view (reveal in finally)

    currentWsId = (pendingSelectWs && wsList.some(w=>w.id===pendingSelectWs)) ? pendingSelectWs
                : (last && wsList.some(w=>w.id===last)) ? last
                : (wsList[0] && wsList[0].id);
    pendingSelectWs=null;
    try{ if(currentWsId) localStorage.setItem("ayanu.lastWs", currentWsId); }catch(_){}

    if(currentWsId===last && earlyData!=null) data=normalizeData(earlyData);  // reuse the parallel fetch
    else await loadWorkspaceData();
    setView("edit"); updateModeButtons();
    currentDate=todayStr(); calYM=currentDate.slice(0,7);
    renderClean();
    setSyncStatus("saved");
  } finally {
    reveal();   // always reveal (even on partial failure) so the splash never sticks
  }
}

/* ---------------- Report ---------------- */
let reportRange = null;   // {from, to} ISO dates, inclusive

/* Flatten a Task[] (including nested children) into a single list. */
function flattenTasks(list, out){
  out = out || [];
  (list||[]).forEach(t=>{ out.push(t); if(t.children && t.children.length) flattenTasks(t.children, out); });
  return out;
}
function estOf(t){ const n=parseFloat(t.est); return isNaN(n)?0:n; }
function pct(n,d){ return d ? Math.round(n/d*100)+"%" : "—"; }
function fmtH(h){ return String(Math.round(h*10)/10); }

/* Aggregate the current workspace's tickets within [from,to] (inclusive ISO dates). */
function computeReport(from, to){
  const tickets = ws().tickets || {};
  const days = Object.keys(tickets).filter(d=> d>=from && d<=to).sort();
  const rows = days.map(d=>{
    const tasks = flattenTasks(tickets[d].tasks);
    const done = tasks.filter(t=>t.done);
    return {
      date: d,
      total: tasks.length,
      done: done.length,
      est: tasks.reduce((s,t)=>s+estOf(t),0),
      estDone: done.reduce((s,t)=>s+estOf(t),0),
      top: tasks.filter(t=>t.prio!=="semi").length,
      semi: tasks.filter(t=>t.prio==="semi").length,
    };
  });
  const sum = rows.reduce((a,r)=>({
    total:a.total+r.total, done:a.done+r.done, est:a.est+r.est,
    estDone:a.estDone+r.estDone, top:a.top+r.top, semi:a.semi+r.semi,
  }), {total:0,done:0,est:0,estDone:0,top:0,semi:0});
  const ac = acList();
  return {rows, sum, days:rows.length, ac:{total:ac.length, done:ac.filter(a=>a.done).length}};
}

function defaultReportRange(){ const to=todayStr(); return {from: to.slice(0,8)+"01", to}; }
function lastNDays(n){ const d=new Date(); d.setDate(d.getDate()-(n-1)); return {from:isoOf(d), to:todayStr()}; }
function allRange(){ const ks=Object.keys(ws().tickets||{}).sort(); return {from:ks[0]||todayStr(), to:ks[ks.length-1]||todayStr()}; }

function openReport(){
  if(!reportRange) reportRange = defaultReportRange();
  document.getElementById("reportOverlay").classList.add("open");
  renderReport();
}
function closeReport(){ document.getElementById("reportOverlay").classList.remove("open"); }

function statCard(label, val){
  return el("div",{class:"report-stat"}, el("div",{class:"rs-val", text:val}), el("div",{class:"rs-lbl", text:label}));
}

function renderReport(){
  const card = document.getElementById("reportCard");
  card.innerHTML="";
  const {from, to} = reportRange;
  const rep = computeReport(from, to);
  const wsName = (curWs() && curWs().name) || "ワークスペース";

  card.appendChild(el("div",{class:"share-head"},
    el("strong",{text:"📊 レポート"}),
    el("button",{class:"icon-btn", text:"✕", title:"閉じる", onClick:closeReport})
  ));
  card.appendChild(el("div",{class:"share-sub", text:wsName+" ・ 期間集計"}));

  // range pickers
  card.appendChild(el("div",{class:"report-range"},
    el("span",{class:"share-sub", text:"期間"}),
    el("input",{type:"date", class:"share-input", value:from, onChange:e=>{ reportRange.from=e.target.value||from; renderReport(); }}),
    el("span",{text:"〜"}),
    el("input",{type:"date", class:"share-input", value:to, onChange:e=>{ reportRange.to=e.target.value||to; renderReport(); }})
  ));
  card.appendChild(el("div",{class:"report-presets"},
    el("button",{class:"mini-btn", text:"今月", onClick:()=>{ reportRange=defaultReportRange(); renderReport(); }}),
    el("button",{class:"mini-btn", text:"過去30日", onClick:()=>{ reportRange=lastNDays(30); renderReport(); }}),
    el("button",{class:"mini-btn", text:"全期間", onClick:()=>{ reportRange=allRange(); renderReport(); }})
  ));

  // summary stats
  const s = rep.sum;
  card.appendChild(el("div",{class:"report-cards"},
    statCard("タスク", s.total+"件"),
    statCard("完了", s.done+"件"),
    statCard("完了率", pct(s.done, s.total)),
    statCard("見積合計", fmtH(s.est)+"h"),
    statCard("完了分", fmtH(s.estDone)+"h"),
    statCard("対象日数", rep.days+"日")
  ));
  card.appendChild(el("div",{class:"share-sub",
    text:"AfterCheck（現在）: "+rep.ac.done+"/"+rep.ac.total+"（"+pct(rep.ac.done, rep.ac.total)+"）"}));

  // per-day table
  if(rep.rows.length){
    const tbl = el("table",{class:"report-table"});
    tbl.appendChild(el("thead",{}, el("tr",{},
      ...["日付","タスク","完了","完了率","優","準","見積h","完了h"].map(h=>el("th",{text:h}))
    )));
    const tb = el("tbody");
    rep.rows.forEach(r=> tb.appendChild(el("tr",{},
      el("td",{text:r.date}), el("td",{text:String(r.total)}), el("td",{text:String(r.done)}),
      el("td",{text:pct(r.done,r.total)}), el("td",{text:String(r.top)}), el("td",{text:String(r.semi)}),
      el("td",{text:fmtH(r.est)}), el("td",{text:fmtH(r.estDone)})
    )));
    tb.appendChild(el("tr",{class:"report-total"},
      el("td",{text:"合計"}), el("td",{text:String(s.total)}), el("td",{text:String(s.done)}),
      el("td",{text:pct(s.done,s.total)}), el("td",{text:String(s.top)}), el("td",{text:String(s.semi)}),
      el("td",{text:fmtH(s.est)}), el("td",{text:fmtH(s.estDone)})
    ));
    tbl.appendChild(tb);
    card.appendChild(tbl);
  } else {
    card.appendChild(el("div",{class:"report-empty", text:"この期間に入力のある日付はありません。"}));
  }

  card.appendChild(el("div",{class:"report-actions"},
    el("button",{class:"mini-btn primary", text:"CSV出力", onClick:()=>exportReportCsv(rep, wsName)}),
    el("button",{class:"mini-btn", text:"印刷 / PDF", onClick:()=>window.print()})
  ));
}

/* Build a CSV of the per-day report and trigger a download (BOM for Excel/日本語). */
function exportReportCsv(rep, wsName){
  const head = ["日付","タスク数","完了","完了率","優","準","見積h","完了h"];
  const lines = [head.join(",")];
  rep.rows.forEach(r=> lines.push([r.date, r.total, r.done, pct(r.done,r.total), r.top, r.semi, fmtH(r.est), fmtH(r.estDone)].join(",")));
  const s=rep.sum;
  lines.push(["合計", s.total, s.done, pct(s.done,s.total), s.top, s.semi, fmtH(s.est), fmtH(s.estDone)].join(","));
  const csv = "﻿"+lines.join("\r\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = el("a",{href:url, download:"ayanu-report_"+reportRange.from+"_"+reportRange.to+".csv"});
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

document.getElementById("reportBtn").onclick=openReport;

/* close the share / report modals on overlay click / Esc */
document.getElementById("shareOverlay").onclick=(e)=>{ if(e.target.id==="shareOverlay") closeShare(); };
document.getElementById("reportOverlay").onclick=(e)=>{ if(e.target.id==="reportOverlay") closeReport(); };
document.addEventListener("keydown",e=>{ if(e.key==="Escape"){ closeShare(); closeReport(); } });

/* ---------------- Go ---------------- */
/* ---------------- Social login ---------------- */
async function renderSocialButtons(){
  const box=document.getElementById("authSocial");
  const divider=document.getElementById("authDivider");
  box.innerHTML="";
  let provs={};
  try{ provs=await api("/auth/oauth/providers"); }catch(_){ divider.style.display="none"; return; }
  const defs=[
    {id:"google", label:"Google でログイン"},
    {id:"github", label:"GitHub でログイン"},
  ];
  let any=false;
  defs.forEach(d=>{
    if(!provs[d.id]) return;
    any=true;
    box.appendChild(el("button",{class:"auth-social-btn "+d.id, text:d.label,
      onClick:()=>{ location.href="/api/auth/oauth/"+d.id; }}));
  });
  divider.style.display = any ? "" : "none";
}

/* Surface an OAuth callback error (?oauth_error=...) on the login screen. */
function showOAuthError(){
  const oerr=new URLSearchParams(location.search).get("oauth_error");
  if(!oerr) return;
  const msg = oerr==="state" ? "セッションが無効です。もう一度お試しください。"
            : oerr==="unsupported" ? "未対応のログイン方法です。"
            : "ソーシャルログインに失敗しました。";
  document.getElementById("authError").textContent=msg;
  history.replaceState({}, "", location.pathname);
}

async function init(){
  setTimeout(hideBoot, 8000);   // safety: never leave the splash stuck
  showOAuthError();
  renderSocialButtons();
  try{
    const me=await api("/auth/me");      // existing session?
    currentUserEmail=me.email;
    await afterLogin();                  // renders, then reveals + hides splash
  }catch(_){
    setAuthMode("login");
    showApp(false); showAuth(true);
    hideBoot();                          // show the login screen cleanly
  }
}
init();
