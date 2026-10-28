export const INDEX_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="搜尋「布丁布丁吃什麼？」的公開 Facebook 貼文。支援關鍵字與語意查詢。">
  <meta name="theme-color" content="#f5f6f2">
  <title>布丁布丁吃布丁｜部落格知識搜尋</title>
  <style>
    :root{color-scheme:light;--ink:#202923;--muted:#64716a;--line:#dfe5df;--paper:#f5f6f2;--card:#fff;--green:#285c45;--green-dark:#17432f;--wash:#e8f0e9;--gold:#c79336}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"Noto Sans TC","Microsoft JhengHei",sans-serif}
    a{color:var(--green-dark)}.wrap{width:min(920px,calc(100% - 36px));margin:0 auto}.hero{padding:64px 0 38px}.brand{display:inline-flex;align-items:center;gap:9px;color:var(--green);font-size:13px;font-weight:750;letter-spacing:.09em;text-transform:uppercase}.brand-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:var(--green);color:#fff;font-size:15px;letter-spacing:0}.hero h1{max-width:680px;margin:20px 0 8px;font-size:clamp(34px,7vw,58px);line-height:1.15;letter-spacing:-.04em}.hero p{max-width:620px;margin:0;color:var(--muted);font-size:17px}
    .search{padding:22px;background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:0 15px 40px #203b2910}.search-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}.query{width:100%;min-height:56px;padding:0 17px;border:1px solid var(--line);border-radius:14px;background:#fcfdfb;color:var(--ink);font:inherit;font-size:17px;outline:none}.query:focus{border-color:var(--green);box-shadow:0 0 0 3px #285c4518}.submit{min-height:56px;padding:0 22px;border:0;border-radius:14px;background:var(--green);color:#fff;font:inherit;font-weight:700;cursor:pointer}.submit:hover{background:var(--green-dark)}.options{display:flex;align-items:center;gap:10px;margin-top:13px;color:var(--muted);font-size:14px}.options select{padding:7px 30px 7px 10px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);font:inherit}
    .recent{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:16px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}.recent input{width:76px;padding:9px 10px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);font:inherit}.recent button{padding:9px 16px;border:1px solid var(--green);border-radius:9px;background:var(--wash);color:var(--green-dark);font:inherit;font-weight:700;cursor:pointer}.recent button:hover{background:#d8e9db}
    .status{min-height:26px;margin:22px 2px 10px;color:var(--muted);font-size:14px}.results{display:grid;gap:12px}.result{padding:20px 22px;background:var(--card);border:1px solid var(--line);border-radius:17px}.result h2{margin:0 0 5px;font-size:20px;line-height:1.4}.result h2 a{text-decoration:none}.result h2 a:hover{text-decoration:underline}.meta{display:flex;flex-wrap:wrap;gap:8px 14px;color:var(--muted);font-size:13px}.excerpt{margin:13px 0 0;color:#3c4941;white-space:pre-wrap}.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px}.tag{padding:3px 9px;border-radius:999px;background:var(--wash);color:var(--green-dark);font-size:12px}.empty{padding:30px 22px;border:1px dashed #b8c5ba;border-radius:17px;color:var(--muted);text-align:center}.info{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:40px 0}.info-card{padding:18px 20px;border:1px solid var(--line);border-radius:16px;background:#ffffff80}.info-card strong{display:block;margin-bottom:4px}.info-card p{margin:0;color:var(--muted);font-size:14px}.info-card code{font-size:13px}.footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;padding:20px 0 35px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}.footer a{font-weight:650}
    @media(max-width:620px){.hero{padding-top:42px}.search{padding:15px;border-radius:18px}.search-form{grid-template-columns:1fr}.submit{width:100%}.info{grid-template-columns:1fr}.result{padding:17px}}
  </style>
</head>
<body>
  <main class="wrap">
    <header class="hero">
      <div class="brand"><span class="brand-mark">布</span> Pulipuli Facebook Knowledge</div>
      <h1>從 Facebook 貼文裡，<br>找到你要的答案。</h1>
      <p>搜尋「布丁布丁吃什麼？」Facebook 粉絲專頁的公開貼文。可以輸入主題、技術名稱或一段自然語言問題。</p>
    </header>

    <section class="search" aria-label="Facebook 貼文搜尋">
      <form id="search-form" class="search-form">
        <input id="query" class="query" type="search" minlength="2" maxlength="300" placeholder="例如：Proxmox 如何設定 Ceph？" autocomplete="off" required>
        <button class="submit" type="submit">搜尋貼文</button>
      </form>
      <div class="options"><label for="mode">搜尋方式</label><select id="mode"><option value="hybrid">混合搜尋</option><option value="semantic">語意搜尋</option><option value="keyword">關鍵字搜尋</option></select><span>混合搜尋會合併關鍵字與語意結果</span></div>
      <div class="recent"><label for="recent-count">最新貼文篇數</label><input id="recent-count" type="number" min="1" max="50" step="1" value="5"><button id="recent-button" type="button">列出最新貼文</button></div>
    </section>

    <div id="status" class="status" role="status" aria-live="polite"></div>
    <section id="results" class="results" aria-live="polite"></section>

    <section class="info" aria-label="服務資訊">
      <div class="info-card"><strong>給 ChatGPT 使用</strong><p>在 ChatGPT 的 MCP 設定中加入這個 Worker 的 <code>/mcp</code> 網址，即可搜尋與讀取貼文。</p></div>
      <div class="info-card"><strong>資料來源與更新</strong><p>資料來自Facebook 粉絲專頁公開貼文，初次建置會分批回填，之後每兩天檢查更新。</p></div>
    </section>

    <footer class="footer"><span>由布丁布丁吃什麼？（pulipulichen）建立</span><span><a href="https://blog.pulipuli.info/" rel="noopener">部落格</a>　·　<a href="https://github.com/pulipulichen/pulipuli-facebook-knowledge-mcp" rel="noopener">GitHub 專案</a></span></footer>
  </main>
  <script>
    const form=document.querySelector('#search-form');
    const input=document.querySelector('#query');
    const mode=document.querySelector('#mode');
    const recentCount=document.querySelector('#recent-count');
    const recentButton=document.querySelector('#recent-button');
    const status=document.querySelector('#status');
    const results=document.querySelector('#results');
    const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const formatDate=value=>{if(!value)return '';const date=new Date(value);return Number.isNaN(date.valueOf())?'':new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'long',day:'numeric'}).format(date)};
    const render=items=>{
      if(!items.length){results.innerHTML='<div class="empty">沒有找到符合的貼文，試試其他關鍵字。</div>';return;}
      results.innerHTML=items.map(item=>'<article class="result"><h2><a href="'+escapeHtml(item.url)+'" target="_blank" rel="noopener">'+escapeHtml(item.title)+'</a></h2><div class="meta"><span>'+escapeHtml(formatDate(item.publishedAt))+'</span><span>'+escapeHtml(item.url)+'</span></div><p class="excerpt">'+escapeHtml(item.excerpt)+'</p>'+(item.tags?.length?'<div class="tags">'+item.tags.map(tag=>'<span class="tag">'+escapeHtml(tag)+'</span>').join('')+'</div>':'')+'</article>').join('');
    };
    recentButton.addEventListener('click',async()=>{
      const n=Number(recentCount.value);
      if(!Number.isInteger(n)||n<1||n>50){status.textContent='請輸入 1 到 50 的整數。';return;}
      status.textContent='載入最新貼文中…';results.innerHTML='';
      try{
        const response=await fetch('/api/recent?n='+n,{headers:{Accept:'application/json'}});
        const body=await response.json();
        if(!response.ok)throw new Error(body.error?.message||'讀取失敗');
        status.textContent='最近 '+body.count+' 篇貼文';
        render(body.results||[]);
      }catch(error){status.textContent=error.message||'目前無法載入最新貼文。';}
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const query=input.value.trim();
      if(query.length<2)return;
      status.textContent='搜尋中…';results.innerHTML='';
      const params=new URLSearchParams({q:query,mode:mode.value,limit:'20'});
      try{
        const response=await fetch('/api/search?'+params.toString(),{headers:{Accept:'application/json'}});
        const body=await response.json();
        if(!response.ok)throw new Error(body.error?.message||'搜尋失敗');
        status.textContent='找到 '+body.count+' 篇貼文';
        render(body.results||[]);
      }catch(error){status.textContent=error.message||'搜尋服務暫時無法使用。';}
    });
  </script>
</body>
</html>`;
