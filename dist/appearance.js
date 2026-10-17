// Shared header theme menu; no backend URL or mode controls.
function setAppearance(theme){
 if(['light','dark','system'].indexOf(theme)<0)return;
 if(typeof APK_SETTINGS!=='undefined'){APK_SETTINGS.theme=theme;writeStore('lift-settings',APK_SETTINGS);applyTheme();}
 else{localStorage.setItem('wlf-web-theme',theme);applyWebAppearance();}
 document.querySelectorAll('.appearance-menu').forEach(function(m){m.open=false;});
}
function applyWebAppearance(){var theme=localStorage.getItem('wlf-web-theme')||'system';document.documentElement.dataset.theme=(theme==='dark'||theme==='system'&&matchMedia('(prefers-color-scheme:dark)').matches)?'dark':'light';}
document.addEventListener('DOMContentLoaded',function(){if(typeof APK_SETTINGS==='undefined'){applyWebAppearance();matchMedia('(prefers-color-scheme:dark)').addEventListener('change',applyWebAppearance);}document.addEventListener('click',function(e){document.querySelectorAll('.appearance-menu[open]').forEach(function(m){if(!m.contains(e.target))m.open=false;});});document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('.appearance-menu[open]').forEach(function(m){m.open=false;});});});
