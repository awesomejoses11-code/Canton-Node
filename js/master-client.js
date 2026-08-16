(function(){
Promise.all([
  fetch('/js/mc-tok-a.txt?v=2').then(function(r){return r.text();}),
  fetch('/js/mc-tok-b.txt?v=2').then(function(r){return r.text();})
]).then(function(p){
  var s=document.createElement('script');
  s.text=atob(p[0]+p[1]);
  document.head.appendChild(s);
}).catch(function(e){console.error('[master-client]',e);});
})();
