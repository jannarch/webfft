// WebSDR JavaScript part
// Copyright 2007-2014, Pieter-Tjerk de Boer, pa3fwm@websdr.org; all rights reserved.
// Naturally, distributing this file by the original WebSDR server software to original WebSDR clients is permitted.

// variables governing what the user listens to:
var lo=-2.7,hi=-0.3;   // edges of passband, in kHz w.r.t. the carrier
var mode="FM";            // 1 if AM, 0 otherwise (SSB/CW); or text "AM", "FM" etc
var band=0;            // id of the band we're listening to
var freq=bandinfo[0].vfo;  // frequency (of the carrier) in kHz
var memories = [ ];
//var buffinit=0;

// variables governing what the user sees:
var chatmsgs, Views={ allbands:0, othersslow:1, oneband:2, blind:3 };
var view=Views.blind;
var nwaterfalls=0;
var waterslowness=5;
var waterheight=100;
var watermode=1;
var scaleheight=14;

// information about the available "virtual" bands:
// contains: effsamplerate, effcenterfreq, zoom, start, minzoom, maxzoom, samplerate, centerfreq, vfo, scaleimgs, realband
var bi = new Array();
// number of bands:
var nvbands=nbands;
//var geo = "";
// references to objects on the screen:
var smeterminobj;	//used in new noise metrics
var noise=0;		//used in new noise metrics
var snr=1;		//used in new noise metrics
var scaleobj;
var scaleobjs = new Array();
var scaleimgs0 = new Array();
var scaleimgs1 = new Array();
var passbandlineobj;
var passbandobj;
var edgelowerobj;
var edgeupperobj;
var carrierobj;
var smeterobj;
var numericalsmeterobj;
var smeterpeakobj;
var numericalsmeterpeakobj;
var pointsobj;
var waterfallapplet = new Array();
var soundapplet = null;

// timers:
var interval_updatesmeter;
var interval_ajax3;
var timeout_idle;
var setfreqif_fut_timer;  // timer for typing in the frequency field

// misc
var serveravailable=-1;  // -1 means yet to be tested, 0 and 1 mean false and true
var smeterpeaktimer=2;
var smetermintimer=2;	//initialises noise window timer
var smeterpeak=0;
var smetermin=2e3;	//initalises min level (updates recusrively during window)
var allloadeddone = !1;
var lastsquelch = 1;

var waitingforwaterfalls=0;  // number of waterfallapplets that are still in the process of starting
var band_fetchdxtimer=new Array();
var hidedx=0;
var usejavawaterfall=1;
var usejavasound=1;
var javaerr=0;
var isTouchDev = false;

// derived quantities:
var khzperpixel = smeterminbyband = bandinfo[band].samplerate / 1024;
var passbandobjstart=0;    // position (in pixels) of start of passband on frequency axis, w.r.t. location of carrier
var passbandobjwidth=0;    // width of passband in pixels
var centerfreq=bandinfo[band].centerfreq;
var lastmodea = new Array;
var lfmw = "25.0 kHz",
  lfm = "12.5 kHz",
  lfmn = "8.5 kHz",
  lfmv = "6.25 kHz",
  lamw = "13.0 kHz",
  lam = "9.0 kHz",
  lamn = "7.0 kHz",
  lamv = "6.0 kHz",
  lusbw = "2.9 kHz",
  lusb = "2.6 kHz",
  lusbn = "2.3 kHz",
  lusbv = "1.7 kHz",
  llsbw = "2.9 kHz",
  llsb = "2.6 kHz",
  llsbn = "2.3 kHz",
  llsbv = "1.7 kHz",
  lcww = "0.8 kHz",
  lcw = "0.4 kHz",
  lcwn = "0.06 kHz",
  lcwv = "0.01 kHz";

function debug(a)
{
   console.debug(a);
}

// from http://www.switchonthecode.com/tutorials/javascript-tutorial-the-scroll-wheel
function cancelEvent(e)
{
  e = e ? e : window.event;
  if(e.stopPropagation) e.stopPropagation();
  if(e.preventDefault) e.preventDefault();
  e.cancelBubble = true;
  e.cancel = true;
  e.returnValue = false;
  return false;
}

function timeout_idle_do()
{
  try {
    clearInterval(interval_updatesmeter);
  } catch (e) {}
  try {
    clearTimeout(interval_ajax3);
  } catch (e) {}
  var i;
  try {
    for (i = 0; i < nwaterfalls; i++) waterfallapplet[i].destroy();
  } catch (e) {}
  try {
    soundapplet.destroy();
  } catch (e) {}
  document.body.innerHTML = "Idle time out.\n";
}

function timeout_idle_restart()
{
  if (!idletimeout) return;
  try {
    clearTimeout(timeout_idle);
  } catch (e) {}
  timeout_idle = setTimeout("timeout_idle_do();", idletimeout);
}

function send_soundsettings_to_server()
{
  var m = mode;
  "USBW" == m ||
  "USB" == m ||
  "USBN" == m ||
  "LSBW" == m ||
  "LSB" == m ||
  "LSBN" == m ||
  "CWW" == m ||
  "CW" == m ||
  "CWN" == m
    ? (m = 0)
    : "AMW" == m || "AM" == m || "AMN" == m || "AMV" == m
    ? (m = 1)
    : ("FMW" != m && "FM" != m && "FMN" != m && "FMV" != m) || (m = 4);
  try {
    soundapplet.setparam(
      "f=" + freq + "&band=" + band + "&lo=" + lo + "&hi=" + hi + "&mode=" + m + "&name=" + encodeURIComponent(document.usernameform.username.value)
    );
  } catch (e) {}
  try {
    soundapplet.modeinfo(mode);
  } catch (e) {}
  timeout_idle_restart();
}

function setsquelch(e) {
    e = Number(e);
    soundapplet.setparam("squelch=" + e);
    
    var el = document.getElementById("sql_info");
    if (!el) return;

    if (e == 0) {
        el.classList.remove("digit_on");
        el.classList.add("digit_off");
        lastsquelch = 0; // Шумодав выключен
    } else {
        el.classList.remove("digit_off");
        el.classList.add("digit_on");
        lastsquelch = 1; // Шумодав включен
    }
}

function setautonotch(e)
{
    e = Number(e), soundapplet.setparam("autonotch=" + e);
    var t = "digit_on",
    s = "digit_off",
    a = document.getElementById("anf1_info");
    lastanotch1 = 0 == e ? (a.classList.remove(t), a.classList.add(s), 0) : (a.classList.remove(s), a.classList.add(t), 1)
}

function setmute(e)
{
    e = Number(e), soundapplet.setparam("mute=" + e);
    var t = "digit_on_mute",
    s = "digit_off",
    a = document.getElementById("mute_info");
    0 == e ? (a.classList.remove(t), a.classList.add(s)) : (a.classList.remove(s), a.classList.add(t))
}

function setnotch2(e)
{
    e = Number(e), soundapplet.setnotch2(e);
    var t = "digit_on",
    s = "digit_off",
    a = document.getElementById("anf2_info");
    lastanotch2 = 0 == e ? (a.classList.remove(t), a.classList.add(s), 0) : (a.classList.remove(s), a.classList.add(t), 1)
}

function setnoise(a)
{
   a=Number(a);
   soundapplet.setnoise(a);
}

function setlmsnr(e)
{
    e = Number(e), soundapplet.setlmsnr(e);
    var t = "digit_on",
    s = "digit_off",
    a = document.getElementById("nr_info");
    lastlmsnr = 0 == e ? (a.classList.remove(t), a.classList.add(s), 0) : (a.classList.remove(s), a.classList.add(t), 1)
}

function sethighboost(e)
{
    e = Number(e), soundapplet.sethighboost(e);
    var t = "digit_on",
    s = "digit_off",
    a = document.getElementById("hb_info");
    lasthighboost = 0 == e ? (a.classList.remove(t), a.classList.add(s), 0) : (a.classList.remove(s), a.classList.add(t), 1)
}

function draw_passband()
{
  passbandobjstart = Math.round((lo - 0.045) / khzperpixel);
  passbandobjwidth = Math.round((hi + 0.045) / khzperpixel) - passbandobjstart;
  if (passbandobjwidth == 0) passbandobjwidth = 1;
  passbandobj.style.width = passbandobjwidth + "px";
  if (!scaleobj) return;

  var x = (freq - centerfreq) / khzperpixel + 512;
  var maxx = parseInt(scaleobj.style.width);
  if (isTouchDev && x > maxx) x = maxx;
  var y = scaleobj.offsetTop + 15;
  passbandobj.style.top = y + "px";
  edgelowerobj.style.top = y + "px";
  edgeupperobj.style.top = y + "px";
  carrierobj.style.top = y + "px";
  carrierobj.style.left = x + "px";
  x = x + passbandobjstart;
  passbandobj.style.left = x + "px";
  edgelowerobj.style.left = x - 11 + "px";
  edgeupperobj.style.left = x + passbandobjwidth + "px";
    updateVerticalStrip();  // добавляем в конец
}

function volumedb(vol)
{
  document.getElementById('volumedb').innerHTML="" + vol;
}

function iscw()
{
   return hi-lo < 1.0;
}

function nominalfreq()
{
  if (iscw()) return freq + (hi + lo) / 2;
  return freq;
}

function freq2x(f,b)
{
   return (f-bi[b].effcenterfreq)*1024/bi[b].effsamplerate+512;
}

function setwaterfall(b,f)
// adjust waterfall so passband is visible
{
   if (waitingforwaterfalls>0) return;
   var x = freq2x(f,b);
   if (x<0 || x>=1024) wfset_freq(b, bi[b].zoom, f);
}

function dx(freq,mode,text)
// called by updates fetched from the server
{
   dxs.push( { freq:freq, mode:mode, text:text } );
}

function setfreqm(b,f,mo)
{
   setband(b);
   set_mode(mo);
   createCookie("last-mode-a", lastmodea = mode, 3650);
   if (iscw()) f-=(hi+lo)/2;
   setfreq(f);
}

function showdx(b)
{
   var s='';
   if (!hidedx) {
      var mems=memories.slice();
      for (i=0;i<mems.length;i++) mems[i].nr=i;
      mems.sort(function(a,b){return a.nomfreq-b.nomfreq});
      for (i=0;i<dxs.length;i++) {
         var x = freq2x(dxs[i].freq,b);
         var nextx;
         if (x>1024) break;
         if (i<dxs.length-1) nextx=freq2x(dxs[i+1].freq,b);
         else nextx=1024;
         if (nextx>=1024) nextx=1280;
         if (x<0) continue;
         var fr=dxs[i].freq;
         var mo=dxs[i].mode;
         s+='<div title="" class="statinfo2" style="max-width:'+(nextx-x)+'px;left:'+(x-6)+'px;top:'+(44-scaleheight)+'px;">';
         s+='<div class="statinfo1"><div class="statinfo0" title="'+fr+','+mo+'" onclick="setfreqm(b,'+fr+','+"'"+mo+"'"+');">'+dxs[i].text+'<\/div><\/div><\/div>';
         s+='<div title="" class="statinfol" style="width:1px;height:44px;position:absolute;left:'+x+'px;top:-'+scaleheight+'px;"><\/div>';
      }
      for (i=0;i<mems.length;i++) if (mems[i].band==b) {
         var x=freq2x(mems[i].nomfreq,b);
         var nextx;
         if (x>1024) break;
         if (i<mems.length-1) nextx=freq2x(mems[i+1].nomfreq,b);
         else nextx=1024;
         if (nextx>=1024) nextx=1280;
         if (x<0) continue;
         var fr=mems[i].freq;
         var mo=mems[i].mode;
         s+='<div title="" class="statinfo2l" style="max-width:'+(nextx-x)+'px;left:'+(x-6)+'px;top:'+(64-scaleheight)+'px;">';
         var l=mems[i].label;
         if (!l || l=='') l='mem '+mems[i].nr;
         s+='<div class="statinfo1l"><div class="statinfo0l" title="'+fr+','+mo+'" onclick="setfreqm(b,'+fr+','+"'"+mo+"'"+');">'+l+'<\/div><\/div><\/div>';
         s+='<div title="" class="statinfoll" style="width:1px;height:64px;position:absolute;left:'+x+'px;top:-'+scaleheight+'px;"><\/div>';
      }
   }
   document.getElementById('blackbar'+band2id(b)).innerHTML=s;
   if (s!='') {
      document.getElementById('blackbar'+band2id(b)).style.height='64px';
   } else {
      document.getElementById('blackbar'+band2id(b)).style.height='30px';
   }
}

function fetchdx(b)
{
  var xmlHttp;
  try { xmlHttp=new XMLHttpRequest(); }
    catch (e) { try { xmlHttp=new ActiveXObject("Msxml2.XMLHTTP"); }
      catch (e) { try { xmlHttp=new ActiveXObject("Microsoft.XMLHTTP"); }
        catch (e) { alert("Your browser does not support AJAX!"); return false; } } }
  xmlHttp.onreadystatechange=function()
    {
    if(xmlHttp.readyState==4)
      {
        if (xmlHttp.responseText!="") {
          eval(xmlHttp.responseText);
          showdx(b);
        }
      }
    }
  var url="/~~fetchdx?min="+(bi[b].effcenterfreq-bi[b].effsamplerate/2)+"&max="+(bi[b].effcenterfreq+bi[b].effsamplerate/2);
  xmlHttp.open("GET",url,true);
  xmlHttp.send(null);
}

function setscaleimgs(b,id)
{
   var e=bi[b];
   var st=e.start>>(e.maxzoom-e.zoom);
   if (st<0) scaleimgs0[id].src="scaleblack.png";
   else scaleimgs0[id].src = e.scaleimgs[e.zoom][st>>10];
   if (e.scaleimgs[e.zoom][1+(st>>10)]) scaleimgs1[id].src = e.scaleimgs[e.zoom][1+(st>>10)];
   else scaleimgs1[id].src="scaleblack.png";
   st+=1024;
   scaleimgs0[id].style.left = (-(st%1024))+"px";
   scaleimgs1[id].style.left = (1024-(st%1024))+"px";
}

// this function is called from java when the scrollwheel is moved to change the zoom
function zoomchange(id,zoom,start)
{
   var b=id2band(id);
   var e=bi[b];
   var oldzoom=e.zoom;
   e.effsamplerate = e.samplerate/(1<<zoom);
   e.effcenterfreq = e.centerfreq - e.samplerate/2 + (start*(e.samplerate/(1<<e.maxzoom))/1024) + e.effsamplerate/2;
   e.zoom=zoom;
   e.start=start;
   setscaleimgs(b,id);
   if (b==band) {
      khzperpixel = bi[band].effsamplerate/1024;
      centerfreq = bi[band].effcenterfreq;
      updbw();
   }
   if (!hidedx) {
      clearTimeout(band_fetchdxtimer[b]);
      if (zoom!=oldzoom) {
         dxs=[]; document.getElementById('blackbar'+id).innerHTML=""; 
         fetchdx(b);
      } else {
         
            showdx(b);
            band_fetchdxtimer[b] = setTimeout('dxs=[]; fetchdx('+b+');',400);
         
      }
   }
}

function set_volume(v)
{
    try { soundapplet.setvolume(Math.pow(10,v/10.)) } catch (e) {};
    //settings_store();
}

var dont_update_textual_frequency = !1;
function setfreq(f) { // Используем 'f' как в твоей функции
    createCookie("last-freq-a", lastfreqa = f, 3650); // Используем 'f' для cookie
    createCookie("last-mode-a", lastmodea = mode, 3650);
    createCookie("last-band-a", lastbanda = band, 3650);
    createCookie("last-lo-a", lastloa = lo, 3650);
    createCookie("last-hi-a", lasthia = hi, 3650);
    try {
        clearTimeout(setfreqif_fut_timer);
    } catch (e) {}
    if (freq = f, // Обновляем глобальную freq с 'f'
//        document.getElementById("dummyforie").style.display = "none",
//        document.getElementById("dummyforie").style.display = "block",
        send_soundsettings_to_server(),
        view != Views.blind && draw_passband(), !dont_update_textual_frequency) {
        var nomfreq = nominalfreq(); // Используем 'e' локально для nomfreq

        if (nomfreq.toFixed) { // Проверяем, что nomfreq - число
            // Обновляем скрытое поле ввода
            if (document.freqform && document.freqform.frequency) {
                document.freqform.frequency.value = nomfreq.toFixed(2);
            }

            // Обновляем текстовые элементы VFO
            if (document.getElementById("freq-1")) {
                document.getElementById("freq-1").innerHTML = nomfreq.toFixed(2).slice(0, -6);
            }
            if (document.getElementById("freq-2")) {
                document.getElementById("freq-2").innerHTML = nomfreq.toFixed(2).substr(-6, 3);
            }
            if (document.getElementById("freq-3")) {
                document.getElementById("freq-3").innerHTML = nomfreq.toFixed(2).substr(-2);
            }
            // Обновляем точку МГц для VFO
            if (document.getElementById("freq-dot")) {
                document.getElementById("freq-dot").style.display = f < 1000 ? "none" : "inline"; // Используем 'f'
            }
          // Удаляем часть тернарного оператора, связанную с else
        } else {
            // Старый способ для совместимости, если nomfreq не число
            if (document.freqform && document.freqform.frequency) {
                document.freqform.frequency.value = nomfreq + " kHz";
            }
        }

        // Теперь блок try...catch будет идти сразу после if/else
        try {
            document.getElementById("userfreq").innerHTML = nomfreq.toFixed(2).slice(0, -6) + "." + nomfreq.toFixed(2).substr(-6, 3) + ".<small>" + nomfreq.toFixed(3).substr(-3) + "</small>",
                0 == smeterminbyband ? smetermintimer = .3 : smeterminbyband = 0;
        } catch (e) {}
        bandlabel(); // Если эта функция есть, вызови ее
        miscmode();
    }
}

function setfreqb(f)
// sets frequency but also autoselects band
{
   if (iscw()) f-=(hi+lo)/2;
   var e=bi[band];
   if (f>e.centerfreq-e.samplerate/2-4 && f<e.centerfreq+e.samplerate/2+4) {
      // new frequency is in the current band
      setwaterfall(band,f);
      setfreq(f);
      return;
   }
   // new frequency is not in the current band: then search through all bands until we find the right one (if any)
   for (i=0;i<nvbands;i++) {
      e=bi[i];
      c=e.centerfreq;
      w=e.samplerate/2+4;
      if (f>c-w && f<c+w) {
         e.vfo=f;
         setband(i);
         return;
      } 
   }
}

function setfreqif(str)
// called when frequency is entered textually
{
   f=parseFloat(str);
   if (!(f>0)) return;
   dont_update_textual_frequency=true;
   setfreqb(f);
   dont_update_textual_frequency=false;
   document.freqform.frequency.value=str;
    miscmode()
}

function setfreqif_fut(str)
// called when typing in the frequency field; schedules a frequency update in the future, in case no more key presses follow soon
{
   try { clearTimeout(setfreqif_fut_timer); } catch (e) {} ;
   setfreqif_fut_timer = setTimeout('setfreqif('+str+')',10);
}

function setmf(m, l, h)   // "set mode and filter"
{
   mode=m.toUpperCase();
   lo=l;
   hi=h;
   updbw();
}

function set_mode(e)
{
  switch (e.toUpperCase()) {
    case "CWW":
      setmf("cww", -1.15, -0.35);
      break;
    case "CW":
      setmf("cw", -0.95, -0.55);
      break;
    case "CWN":
      setmf("cwn", -0.78, -0.72);
      break;
    case "CWV":
      setmf("cwv", -0.72, -0.75);
      break;
    case "LSBW":
      setmf("lsbw", -3.0, -0.1);
      break;
    case "LSB":
      setmf("lsb", -2.8, -0.2);
      break;
    case "LSBN":
      setmf("lsbn", -2.6, -0.3);
      break;
    case "LSBV":
      setmf("lsbv", -2.2, -0.5);
      break;
    case "USBW":
      setmf("usbw", 0.1, 3.0);
      break;
    case "USB":
      setmf("usb", 0.2, 2.8);
      break;
    case "USBN":
      setmf("usbn", 0.3, 2.6);
      break;
    case "USBV":
      setmf("usbv", 0.5, 2.2);
      break;
    case "AMW":
      setmf("amw", -6.5, 6.5);
      break;
    case "AM":
      setmf("am", -4.5, 4.5);
      break;
    case "AMN":
      setmf("amn", -3.5, 3.5);
      break;
    case "AMV":
      setmf("amv", -3, 3);
      break;
    case "FMW":
      setmf("fmw", -12.5, 12.5);
      break;
    case "FM":
      setmf("fm", -6.25, 6.25);
      break;
    case "FMN":
      setmf("fmn", -4.25, 4.25);
      break;
    case "FMV":
      setmf("fmv", -3.125, 3.125);
  }
  mode_wide();
}

function mode_wide()
{
  "fm" == fmode
    ? ((document.getElementById("fil-preset-03").innerHTML = lfmw),
      (document.getElementById("fil-preset-02").innerHTML = lfm),
      (document.getElementById("fil-preset-01").innerHTML = lfmn),
      (document.getElementById("fil-preset-00").innerHTML = lfmv))
    : "am" == fmode
    ? ((document.getElementById("fil-preset-03").innerHTML = lamw),
      (document.getElementById("fil-preset-02").innerHTML = lam),
      (document.getElementById("fil-preset-01").innerHTML = lamn),
      (document.getElementById("fil-preset-00").innerHTML = lamv))
    : "usb" == fmode
    ? ((document.getElementById("fil-preset-03").innerHTML = lusbw),
      (document.getElementById("fil-preset-02").innerHTML = lusb),
      (document.getElementById("fil-preset-01").innerHTML = lusbn),
      (document.getElementById("fil-preset-00").innerHTML = lusbv))
    : "lsb" == fmode
    ? ((document.getElementById("fil-preset-03").innerHTML = llsbw),
      (document.getElementById("fil-preset-02").innerHTML = llsb),
      (document.getElementById("fil-preset-01").innerHTML = llsbn),
      (document.getElementById("fil-preset-00").innerHTML = llsbv))
    : "cw" == fmode &&
      ((document.getElementById("fil-preset-03").innerHTML = lcww),
      (document.getElementById("fil-preset-02").innerHTML = lcw),
      (document.getElementById("fil-preset-01").innerHTML = lcwn),
      (document.getElementById("fil-preset-00").innerHTML = lcwv)),
    "FMW" == mode ||
    "AMW" == mode ||
    "USBW" == mode ||
    "LSBW" == mode ||
    "CWW" == mode
      ? (document.getElementById("fil-preset-03").classList.add("active"),
        document.getElementById("fil-preset-02").classList.remove("active"),
        document.getElementById("fil-preset-01").classList.remove("active"),
        document.getElementById("fil-preset-00").classList.remove("active"))
      : "FM" == mode ||
        "AM" == mode ||
        "USB" == mode ||
        "LSB" == mode ||
        "CW" == mode
      ? (document.getElementById("fil-preset-03").classList.remove("active"),
        document.getElementById("fil-preset-02").classList.add("active"),
        document.getElementById("fil-preset-01").classList.remove("active"),
        document.getElementById("fil-preset-00").classList.remove("active"))
      : "FMN" == mode ||
        "AMN" == mode ||
        "USBN" == mode ||
        "LSBN" == mode ||
        "CWN" == mode
      ? (document.getElementById("fil-preset-03").classList.remove("active"),
        document.getElementById("fil-preset-02").classList.remove("active"),
        document.getElementById("fil-preset-01").classList.add("active"),
        document.getElementById("fil-preset-00").classList.remove("active"))
      : ("FMV" != mode &&
          "AMV" != mode &&
          "USBV" != mode &&
          "LSBV" != mode &&
          "CWV" != mode) ||
        (document.getElementById("fil-preset-03").classList.remove("active"),
        document.getElementById("fil-preset-02").classList.remove("active"),
        document.getElementById("fil-preset-01").classList.remove("active"),
        document.getElementById("fil-preset-00").classList.add("active"));
}


function freqstep(st)
// do a frequency step, suitable for the current mode
// sign of st indicates direction
// magnitude of st is 1,2 or 3 for small, medium, or large step, with large being one channel (where applicable)
{
   var f=nominalfreq();
   var steps_ssb= [bandinfo[band].tuningstep, .05, 1.5, 2.5, 5, 10 ];
   var steps_am5= [0.1, 1, 5];
   var steps_am9= [0.1, 1, 9];
   var steps_fm= [1, 5, 12.5 ];
   var steps=steps_ssb;
   var grid=false;
   var i=Math.abs(st)-1;   
   if (mode=="AM") {
      if (freq<1800) steps=steps_am9; else steps=steps_am5;
      if (i>=1) grid=true;
   }
   if (mode=="FM") {
      steps=steps_fm;
      if (i>=1) grid=true;
   }
   var d=steps[i];
   var f=(st>0)?f:-f;
   if (!grid) f=f+d;
   else f=d*Math.ceil(f/d+0.1);
   f=(st>0)?f:-f;
   if (iscw()) f-=(hi+lo)/2;
   setfreq(f);
}

function setfreqtune(s)
{
   var param = new RegExp("([0-9.]*)([^&#]*)").exec(s);
   if (!param[1]) return;
   if (param[2]) set_mode(param[2]);
   setfreqif(param[1]);
}

// Работа с пользовательскими закладками/mempries
// Загрузка закладок из localStorage при запуске
try {
    memories = JSON.parse(localStorage.getItem('memories')) || [];
} catch (e) {
    console.error('Ошибка загрузки закладок из localStorage:', e);
}

// Константы для пагинации
const ITEMS_PER_PAGE = 5; // Количество закладок на странице
let currentPage = 1; // Текущая страница

// ПАТЧ:
//Если вы находитесь на 2-й странице закладок и удаляете оттуда последнюю (пятую) запись,
//то таблица перерисуется пустой, так как переменная currentPage останется равной 2,
//а записей для второй страницы больше нет.
function mem_recall(i) {
    if (memories[i]) {
        // Сброс предыдущей подсветки (только очистка стилей строки!)
        if (currentHighlight !== -1) {
            const prevRow = document.querySelector(`#memories-table-container tr[data-mem-index="${currentHighlight}"]`);
            if (prevRow) prevRow.style.backgroundColor = '';
        }

        // Установка новой подсветки
        currentHighlight = i;
        const newRow = document.querySelector(`#memories-table-container tr[data-mem-index="${i}"]`);
        if (newRow) newRow.style.backgroundColor = 'rgba(255, 183, 3, 0.15)'; // Теплый янтарный отсвет активной строки

        // Настройка приемника выполняется строго один раз в правильном порядке
        setband(memories[i].band);
        mode = memories[i].mode;
        lo = memories[i].lo;
        hi = memories[i].hi;
        updbw();
        setfreq(memories[i].freq);
        setwaterfall(band, memories[i].freq);
    }
}

// Функция для удаления закладки
function mem_erase(i) {
    if (memories[i]) {
        // Сброс подсветки если удаляем активную закладку
        if (currentHighlight === i) currentHighlight = -1;
        
        var b = memories[i].band;
        memories.splice(i, 1);
        
        // Если это была последняя закладка - очищаем хранилище
        if (memories.length === 0) {
            try {
                localStorage.removeItem('memories');
            } catch (e) {
                console.error('Ошибка очистки localStorage:', e);
            }
        }
        
        mem_show();
        showdx(b);
        try {
            localStorage.setItem('memories', JSON.stringify(memories));
        } catch (e) {
            console.error('Ошибка сохранения закладок в localStorage:', e);
        }
    }
}

// Функция для сохранения текущих настроек в закладку
function mem_store(i, currentFreq) {
    var nomf = nominalfreq();
    var l;
    try {
        l = memories[i].label;
    } catch (e) {
        l = '';
    }
    // Сохраняем текущую частоту в закладку
    memories[i] = { freq: currentFreq, nomfreq: nomf, band: band, mode: mode, lo: lo, hi: hi, label: l };
    mem_show();
    showdx(memories[i].band);
    try {
        localStorage.setItem('memories', JSON.stringify(memories));
    } catch (e) {
        console.error('Ошибка сохранения закладок в localStorage:', e);
    }
}

// Функция для редактирования метки закладки
function mem_label(i, nw) {
    if (memories[i]) {
        memories[i].label = nw;
        showdx(memories[i].band);
        try {
            localStorage.setItem('memories', JSON.stringify(memories));
        } catch (e) {
            console.error('Ошибка сохранения закладок в localStorage:', e);
        }
    }
}

// Функция для отображения закладок в виде таблицы
let currentHighlight = -1; // Индекс активной закладки
function mem_show() {
    var container = document.getElementById('memories-table-container');
    if (!container) return;

    // Автоматический откат страницы назад при удалении последней записи
    const totalPages = Math.ceil(memories.length / ITEMS_PER_PAGE);
    if (currentPage > totalPages && totalPages > 0) {
        currentPage = totalPages;
    }
    

    // Очищаем контейнер
    container.innerHTML = '';
    
    // Скрываем таблицу если нет закладок
    if (memories.length === 0) {
        container.innerHTML = '<div class="text-muted text-center">Нет сохранённых закладок</div>';
        return;
    }

    // Создаём таблицу
    var table = document.createElement('table');
    table.className = 'table table-sm table-hover font-roboto mb0'; // Стили Bootstrap для таблицы

    // Заголовок таблицы
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    headerRow.innerHTML = `
        <th class="text-center text-muted f12">#</th>
        <th class="text-center text-muted f12">Частота</th>
        <th class="text-center text-muted f12">Метка</th>
        <th class="text-center text-muted f12">Действия</th>
    `;
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Тело таблицы
    var tbody = document.createElement('tbody');

    // Вычисляем закладки для текущей страницы
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const currentMemories = memories.slice(startIndex, endIndex);

    currentMemories.forEach((memory, i) => {
//        var row = document.createElement('tr');
            var row = document.createElement('tr');
        row.setAttribute('data-mem-index', startIndex + i); // Добавляем атрибут с индексом
    
        // Подсветка активной закладки
        if (startIndex + i === currentHighlight) {
        row.style.backgroundColor = 'rgba(255, 255, 128, 0.3)';
        }

        // Ячейка с порядковым номером
        var numberCell = document.createElement('td');
        numberCell.textContent = startIndex + i + 1; // Порядковый номер
        numberCell.className = 'text-center';

        // Ячейка с частотой
        var freqCell = document.createElement('td');
        freqCell.textContent = `${memory.nomfreq.toFixed(2)} kHz ${memory.mode}`;
        freqCell.className = 'text-center';

        // Ячейка с меткой
        var labelCell = document.createElement('td');
        labelCell.textContent = memory.label || '';
        labelCell.className = 'text-center';

        // Ячейка с действиями
        var actionsCell = document.createElement('td');
        actionsCell.className = 'text-center';

        var recallButton = document.createElement('button');
        recallButton.textContent = 'Перейти';
        recallButton.className = 'btn btn-outline-dark btn-xs';
        recallButton.addEventListener('click', () => mem_recall(startIndex + i));

        var editButton = document.createElement('button');
        editButton.innerHTML = '<i class="fa fa-magic" title="Редактировать" aria-hidden="true"></i>';
        editButton.className = 'btn btn-outline-primary btn-xs';
        editButton.addEventListener('click', () => {
            var newLabel = prompt('Введите новую метку:', memory.label || '');
            if (newLabel !== null) {
                mem_label(startIndex + i, newLabel);
                mem_show();
            }
        });

        var deleteButton = document.createElement('button');
        deleteButton.innerHTML = '<i class="fa fa-times" title="Удалить" aria-hidden="true"></i>';
        deleteButton.className = 'btn btn-outline-danger btn-xs';
        deleteButton.addEventListener('click', () => mem_erase(startIndex + i));

        actionsCell.appendChild(recallButton);
        actionsCell.appendChild(editButton);
        actionsCell.appendChild(deleteButton);

        // Добавляем ячейки в строку
        row.appendChild(numberCell);
        row.appendChild(freqCell);
        row.appendChild(labelCell);
        row.appendChild(actionsCell);

        // Добавляем строку в тело таблицы
        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    // Добавляем таблицу в контейнер
    container.appendChild(table);

    // Добавляем пагинацию, если закладок больше 5
    if (memories.length > ITEMS_PER_PAGE) {
        addPagination();
    }
}

// Функция для добавления пагинации
function addPagination() {
    var container = document.getElementById('memories-table-container');
    if (!container) return;

    // Вычисляем общее количество страниц
    const totalPages = Math.ceil(memories.length / ITEMS_PER_PAGE);

    // Создаём контейнер для пагинации
    var pagination = document.createElement('div');
    pagination.className = 'd-flex justify-content-center mt-3';

    // Кнопка "В начало"
    var firstPageButton = document.createElement('button');
    firstPageButton.innerHTML = '<i class="fa fa-angle-double-left" aria-hidden="true"></i>';
    firstPageButton.className = 'btn btn-outline-secondary btn-xs mx-1';
    firstPageButton.disabled = currentPage === 1;
    firstPageButton.addEventListener('click', () => {
        currentPage = 1;
        mem_show();
    });

    // Кнопка "Назад"
    var prevButton = document.createElement('button');
    prevButton.innerHTML = '<i class="fa fa-chevron-left" aria-hidden="true"></i>';
    prevButton.className = 'btn btn-outline-secondary btn-xs mx-1';
    prevButton.disabled = currentPage === 1;
    prevButton.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            mem_show();
        }
    });

    // Добавляем кнопки "В начало" и "Назад"
    pagination.appendChild(firstPageButton);
    pagination.appendChild(prevButton);

    // Добавляем номера страниц
    for (let i = 1; i <= totalPages; i++) {
        var pageButton = document.createElement('button');
        pageButton.textContent = i;
        pageButton.className = `btn btn-outline-secondary btn-xs mx-1 ${i === currentPage ? 'active' : ''}`;
        pageButton.addEventListener('click', () => {
            currentPage = i;
            mem_show();
        });
        pagination.appendChild(pageButton);
    }

    // Кнопка "Вперёд"
    var nextButton = document.createElement('button');
    nextButton.innerHTML = '<i class="fa fa-chevron-right" aria-hidden="true"></i>';
    nextButton.className = 'btn btn-outline-secondary btn-xs mx-1';
    nextButton.disabled = currentPage === totalPages;
    nextButton.addEventListener('click', () => {
        if (currentPage < totalPages) {
            currentPage++;
            mem_show();
        }
    });

    // Кнопка "В конец"
    var lastPageButton = document.createElement('button');
    lastPageButton.innerHTML = '<i class="fa fa-angle-double-right" aria-hidden="true"></i>';
    lastPageButton.className = 'btn btn-outline-secondary btn-xs mx-1';
    lastPageButton.disabled = currentPage === totalPages;
    lastPageButton.addEventListener('click', () => {
        currentPage = totalPages;
        mem_show();
    });

    // Добавляем кнопки "Вперёд" и "В конец"
    pagination.appendChild(nextButton);
    pagination.appendChild(lastPageButton);

    // Добавляем пагинацию в контейнер
    container.appendChild(pagination);
}

// Функция для отображения/скрытия меню Memories
function toggleMemoriesMenu() {
    var menu = document.getElementById('memories-menu');
    if (menu) {
        // Проверяем вычисленный стиль браузера, чтобы избежать бага двойного клика
        const isHidden = window.getComputedStyle(menu).display === 'none';
        menu.style.display = isHidden ? 'block' : 'none';
    }
}

// Функция для закрытия меню Memories
function closeMemoriesMenu() {
    var menu = document.getElementById('memories-menu');
    if (menu) {
        menu.style.display = 'none';
    }
}

// Инициализация интерфейса при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    // Инициализируем перетаскивание окна
    initDraggableMemories();

    // Кнопка "Memories"
    var memoriesButton = document.getElementById('memories-button');
    if (memoriesButton) {
        memoriesButton.addEventListener('click', toggleMemoriesMenu);
    }

    // Кнопка "Добавить закладку"
    var addButton = document.getElementById('add-memory-button');
    if (addButton) {
        addButton.innerHTML = '<i class="fa fa-check" aria-hidden="true"></i>&nbsp;&nbsp;Добавить'; // Заменяем крестик на галочку
        addButton.addEventListener('click', () => {
            // Получаем текущую частоту и предлагаем её в качестве значения по умолчанию
            var currentFreq = freq; // Предполагаем, что переменная freq содержит текущую частоту
            var defaultLabel = `${currentFreq.toFixed(2)} kHz`; // Частота как значение по умолчанию
            var label = prompt('Введите метку для новой закладки:', defaultLabel);
            if (label !== null) {
                memories.push({
                    freq: currentFreq, // Сохраняем текущую частоту
                    nomfreq: nominalfreq(),
                    band: band,
                    mode: mode,
                    lo: lo,
                    hi: hi,
                    label: label
                });
                mem_show();
                try {
                    localStorage.setItem('memories', JSON.stringify(memories));
                } catch (e) {
                    console.error('Ошибка сохранения закладок в localStorage:', e);
                }
            }
        });
    }

    // Кнопка-крестик для закрытия меню
    var closeButton = document.getElementById('close-memories-menu');
    if (closeButton) {
        closeButton.innerHTML = '<i class="fa fa-times" aria-hidden="true"></i>';
        closeButton.className = 'btn btn-outline-danger btn-xs';
        closeButton.addEventListener('click', closeMemoriesMenu);
    }

    // Инициализация таблицы
    mem_show();
});

// Экспорт закладок в CSV файл
function exportMemoriesToCSV() {
    const csvContent = "data:text/csv;charset=utf-8," 
        + "Freq(kHz),Mode,Label,Low(kHz),High(kHz)\n"
        + memories.map(m => 
            `${m.nomfreq.toFixed(2)},${m.mode},"${m.label}",${m.lo.toFixed(2)},${m.hi.toFixed(2)}`
        ).join("\n");
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "memories.csv");
    document.body.appendChild(link);
    link.click();
}

// Импорт закладок из CSV файла
function importMemoriesFromCSV(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const csvData = e.target.result;
        const rows = csvData.split('\n').slice(1); // Пропускаем заголовок
        
        rows.forEach(row => {
            const [nomfreq, mode, label, lo, hi] = row.split(',');
            if (nomfreq && mode) {
                memories.push({
                    freq: parseFloat(nomfreq),
                    nomfreq: parseFloat(nomfreq),
                    mode: mode.trim(),
                    label: label.replace(/"/g, '').trim(),
                    lo: parseFloat(lo),
                    hi: parseFloat(hi),
                    band: band // Текущая полоса по умолчанию
                });
            }
        });
        
        mem_show();
        localStorage.setItem('memories', JSON.stringify(memories));
    };
    reader.readAsText(file);
}

// Функция для полной очистки всех закладок
function mem_clear_all() {
    if (memories.length === 0) return;
    
    if (confirm('Вы уверены, что хотите удалить ВСЕ закладки? Это действие нельзя отменить!')) {
        // Очищаем массив и связанные переменные
        memories = [];
        currentHighlight = -1;
        
        // Обновляем интерфейс и хранилище
        mem_show();
        try {
            localStorage.removeItem('memories');
        } catch (e) {
            console.error('Ошибка очистки localStorage:', e);
        }
        
        // Дополнительные действия при необходимости
        showdx(band); // Обновляем отображение диапазона
    }
}

// ==========================================================
// ФУНКЦИЯ ПЕРЕТАСКИВАНИЯ (DRAG & DROP) ОКНА МЕМОРЕЙ
// ==========================================================
function initDraggableMemories() {
    const menu = document.getElementById('memories-menu');
    const header = document.getElementById('memories-header');
    
    if (!menu || !header) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    // 1. Восстанавливаем позицию из localStorage при загрузке
    const savedPos = JSON.parse(localStorage.getItem('memories_position'));
    if (savedPos) {
        // Сбрасываем right, так как мы будем позиционировать строго по left и top
        menu.style.right = 'auto'; 
        
        // Защита от того, что пользователь уменьшил окно браузера и панель улетела за край
        let safeLeft = Math.min(Math.max(0, savedPos.left), window.innerWidth - menu.offsetWidth - 20);
        let safeTop = Math.min(Math.max(0, savedPos.top), window.innerHeight - menu.offsetHeight - 20);
        
        menu.style.left = safeLeft + 'px';
        menu.style.top = safeTop + 'px';
    }

    // 2. Начинаем перетаскивание
    header.addEventListener('mousedown', function(e) {
        // Игнорируем клик, если нажали на кнопку закрытия
        if (e.target.closest('button')) return;

        isDragging = true;
        header.style.cursor = 'grabbing';
        
        // Получаем текущие точные координаты элемента
        const rect = menu.getBoundingClientRect();
        
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = rect.left;
        initialTop = rect.top;

        // Отвязываем от правого края, если это первый сдвиг
        menu.style.right = 'auto';
        menu.style.margin = '0'; 

        // Вешаем обработчики на весь документ, чтобы мышь не "слетала" при быстром движении
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
    });

    // 3. Процесс перетаскивания
    function onDrag(e) {
        if (!isDragging) return;
        e.preventDefault(); // отменяем выделение текста

        let dx = e.clientX - startX;
        let dy = e.clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        // Ограничиваем движение границами экрана
        const maxLeft = window.innerWidth - menu.offsetWidth;
        const maxTop = window.innerHeight - menu.offsetHeight;

        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        menu.style.left = newLeft + 'px';
        menu.style.top = newTop + 'px';
    }

    // 4. Остановка перетаскивания и сохранение
    function stopDrag() {
        isDragging = false;
        header.style.cursor = 'grab';
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', stopDrag);

        // Сохраняем новую позицию в LocalStorage
        localStorage.setItem('memories_position', JSON.stringify({
            left: parseInt(menu.style.left, 10),
            top: parseInt(menu.style.top, 10)
        }));
    }
}
// End Работа с пользовательскими закладками/mempries

function wfset_freq(e, t, s) {
    var a = band2id(e)
      , e = bi[e]
      , n = e.samplerate / (1 << t)
      , s = 1024 * (s - e.centerfreq + e.samplerate / 2 - n / 2) / (e.samplerate / (1 << e.maxzoom));
    waterfallapplet[a].setzoom(t, s),
    timeout_idle_restart()
}

function wfset(e) {
    var t = band
      , s = bi[t]
      , a = band2id(t);
    if (timeout_idle_restart(),
    0 == e)
        waterfallapplet[a].setzoom(-2, 512);
    else if (1 == e)
        waterfallapplet[a].setzoom(-1, 512);
    else {
        if (2 == e && wfset_freq(t, s.maxzoom, freq),
        3 == e) {
            for (var n, o = 0; o < frequencyBands.length && !(frequencyBands[o].min <= freq && frequencyBands[o].max >= freq); o++)
                ;
            for (var r, l = ((r = o == frequencyBands.length ? (n = freq - 100,
            freq + 100) : (n = frequencyBands[o].min,
            frequencyBands[o].max)) + n) / 2, i = r - n, d = 0; 2 * i < s.samplerate && d < s.maxzoom; )
                d++,
                i *= 2;
            wfset_freq(t, d, l)
        }
        4 == e && waterfallapplet[a].setzoom(0, 0),
        5 == e && wfset_freq(t, s.zoom, freq)
    }
}


function setview(v)
{
   timeout_idle_restart()
   if ((v==Views.allbands && view==Views.othersslow) || (view==Views.allbands && v==Views.othersslow)) {
      // no need to restart the applets in this case
      view=v;   
      createCookie("view",view,3652);
      waterfallspeed(waterslowness);
      return;
   }

   if (view==Views.blind) {
      var els = document.getElementsByTagName('*');
      for (i=0; i<els.length; i++) {
         if (els[i].className=="hideblind") els[i].style.display="inline";
         if (els[i].className=="showblind") els[i].style.display="none";
      }
   }
   for (i=0;i<nwaterfalls;i++) waterfallapplet[i].destroy();

   view=v;   
   createCookie("view",view,3652);

   document_waterfalls();  // (re)start the waterfall applets

   if (view==Views.blind) {
      var els = document.getElementsByTagName('*');
      for (i=0; i<els.length; i++) {
         if (els[i].className=="showblind") els[i].style.display="inline";
         if (els[i].className=="hideblind") els[i].style.display="none";
      }
      return;
   }

   sethidedx(hidedx);
}

function islsbband(b)
{
   // returns true if default SSB mode for this band should be LSB
   var e=bi[b];
   if (e.centerfreq>3500 && e.centerfreq<4000) return 1;
   if (e.centerfreq>1800 && e.centerfreq<2000) return 1;
   if (e.centerfreq>7000 && e.centerfreq<7400) return 1;
   return 0;
}
// НОВАЯ ФУНКЦИЯ
//В WebSDR у каждого диапазона есть индекс (0, 1, 2...) и имя (например, "160m", "2m"). Настроим переключение по именам диапазонов
// Менять ANT 1 и ANT 2

function updateAntennaSystem(bandIndex) {
    var ant1 = document.getElementById('ant1_info');
    var ant2 = document.getElementById('ant2_info');

    // Если бейджей нет на странице, тихо выходим
    if (!ant1 || !ant2) return;

    // Определяем УКВ по центральной частоте диапазона (всё, что выше 30000 кГц / 30 МГц)
    var isVhfUhf = (bandinfo[bandIndex].centerfreq > 30000);

    if (isVhfUhf) {
        // ANT 1 = УКВ (2м / 70см) -> Включаем ANT 1 (убираем off), выключаем ANT 2 (добавляем off)
        ant1.classList.remove('off');
        ant2.classList.add('off');
    } else {
        // ANT 2 = КВ (мультибенд) -> Включаем ANT 2 (убираем off), выключаем ANT 1 (добавляем off)
        ant1.classList.add('off');
        ant2.classList.remove('off');
    }
}

function setband(b)
{
   if (b<0 || b>=nvbands) return;
   bi[band].vfo=freq;
  
   if (islsbband(band)!=islsbband(b)) {
      // if needed, exchange LSB/USB 
      var tmp=hi;
      hi=-lo;
      lo=-tmp;
       mode = (mode === "USB") ? "LSB" : "USB"; // Компактное условие
       smetermintimer = 0.3; // 
       smeterminbyband = 1;  // 
   }

   band=b;
   var e=bi[b];
   if (nbands>1) document.freqform.group0[band].checked=true;
   if (view==Views.allbands || view==Views.othersslow) {
      scaleobj = scaleobjs[b];
   } else if (view==Views.oneband) {
      scaleobj = scaleobjs[0];
      setscaleimgs(b,0);
      if (waitingforwaterfalls==0) waterfallapplet[0].setband(b, e.maxzoom, e.zoom, e.start);
      if (!hidedx) {
         clearTimeout(band_fetchdxtimer[b]);
         dxs=[]; document.getElementById('blackbar0').innerHTML=""; 
         fetchdx(b);
       }
   }
   setwaterfall(b,e.vfo);
   centerfreq = e.effcenterfreq;
   khzperpixel = e.effsamplerate/1024;
   setfreq(e.vfo);
   waterfallspeed(waterslowness);
    updateVerticalStrip();  // добавляем эту строку
    // Вызываем вашу функцию переключения антенн
   if (typeof updateAntennaSystem === 'function') {
       updateAntennaSystem(b);
   }
}

function sethidedx(h)
{
   hidedx=h;
   if (view==Views.oneband) {
      if (hidedx) {
         dxs=[]; document.getElementById('blackbar0').innerHTML=""; 
         clearTimeout(band_fetchdxtimer[band]);
         document.getElementById('blackbar0').style.height='30px';
      } else {
         showdx(band);
         fetchdx(band);
      }
   } else {
      for (b=0;b<nvbands;b++) {
         if (hidedx) {
            dxs=[]; document.getElementById('blackbar'+band2id(b)).innerHTML=""; 
            clearTimeout(band_fetchdxtimer[b]);
            document.getElementById('blackbar'+band2id(b)).style.height='30px';
         } else {
            showdx(b);
            fetchdx(b);
         }
      }
   }
}

function test_serverbusy()
{
   try { soundapplet.app.l=1; }
    catch (e) {};
   try { serveravailable=soundapplet.getid(); }
    catch (e) {};
   if (serveravailable==0) {
      try { clearInterval(interval_updatesmeter); }
       catch (e) {} ;
      try { clearTimeout(interval_ajax3); } 
       catch (e) {} ;
      var i;
      try { for (i=0;i<nwaterfalls;i++) waterfallapplet[i].destroy(); }
       catch (e) {} ;
      try { soundapplet.destroy(); }
       catch (e) {};
      document.body.innerHTML="Sorry, the WebSDR server is too busy right now; please try again later.\n";
   }
}

var sgraph={
   prevt: 0,
   e0: 80,     // current lower end of scale
   e1: -190,   // current upper end of scale
   d0: 80,     // current estimate of lowest value of interest
   d1: -190,   // current estimate of highest value of interest
   width: 200,
   cnt: 0
};

function s2y(s)
{
   return sgraph.cv.height-(s-sgraph.e0)/(sgraph.e1-sgraph.e0)*sgraph.cv.height;
}

function bandlabel() {
    const band = frequencyBands.find(b => freq >= b.min && freq <= b.max);
    const bandLabel = document.getElementById("band-label");
    if (bandLabel) {
        bandLabel.innerHTML = band ? band.label : "";
    }
}

/**
 * Функция обновления названия диапазона.
 * Определяет радиодиапазон на основе текущей частоты freq (глобальная переменная, в kHz)
 * и выводит его в элемент с id "band-mode".
 * Шкала dBm больше не обновляется — за визуализацию S-метра отвечает другой код.
 */
function miscmode() {
    let bandName;

    // Логика определения диапазона (пороги в kHz)
    if (freq < 0.003) {
        bandName = "--";
    } else if (freq < 0.03) {
        bandName = "ELF";
    } else if (freq < 0.3) {
        bandName = "SLF";
    } else if (freq < 3) {
        bandName = "ULF";
    } else if (freq < 30) {
        bandName = "VLF";
    } else if (freq < 300) {
        bandName = "\u00A0LF"; // неразрывный пробел + LF
    } else if (freq < 3000) {
        bandName = "\u00A0MF";
    } else if (freq < 30000) {
        bandName = "\u00A0HF";
    } else if (freq < 300000) {
        bandName = "VHF";
    } else if (freq < 1260000) {
        bandName = "UHF";
    } else {
        bandName = "SHF";
    }

    // Безопасное обновление элемента band-mode
    const bandModeElement = document.getElementById("band-mode");
    if (bandModeElement) {
        bandModeElement.classList.remove("text-darkgrey");
        bandModeElement.classList.add("text-yellow");
        bandModeElement.innerHTML = bandName;
    }
    // Если элемента band-mode нет — код просто ничего не делает, не вызывает ошибок.
    // Элемент smeter-dbm не используется, поэтому его отсутствие полностью безопасно.
}

/**
 * WebSDR S-Meter & UI Update Function
 * Версия: 5.0 (Full Reconstruction)
 * Включает: Цифровой S-метр, Текстовую шкалу, Индикаторы RX/Overload, 
 *           S-бары (кубики) с логикой Squelch и График (Plotter).
 
 * ФУНКЦИЯ ОБНОВЛЕНИЯ S-МЕТРА (ВЕРСИЯ 22DX - ПОЛНОЕ СООТВЕТСТВИЕ ОРИГИНАЛУ)
 * Сохранены все константы, пороги и логика "жесткого" шумодава.
 */
var last_f;
function updatesmeter() {
    // 1. Используем глобальный флаг загрузки
    if (!allloadeddone) return;

    // 2. Получаем сырые данные (s)
    var s = 0;
    try {
        s = soundapplet.smeter();
    } catch (e) { s = 0; }
    if (s < 0) s = 0;

    // 3. Исправляем баг старта (форсированная калибровка)
    // Если шум (smetermin) равен 2000 (заводской дефолт) или частота сменилась
    if (smetermin === 2000 || (typeof last_f !== 'undefined' && last_f !== freq)) {
        smetermin = s; 
        smeterpeak = s;
        last_f = freq;
    }
    if (typeof last_f === 'undefined') last_f = freq;

    // 4. Расчет цифровых табло (dbOffset берем из логики файла)
    var dbOffset = (freq < 30000) ? 127 : 147;
    var th40 = (freq < 30000) ? 9400 : 9300; // Разделение КВ/УКВ
    var dbText = (s / 100.0 - dbOffset).toFixed(1);
    if (dbText.length < 6) dbText = '&ensp;' + dbText;
    
    // Обновляем глобальные объекты, которые я нашел в твоем файле (строки 625+)
    if (numericalsmeterobj) numericalsmeterobj.innerHTML = dbText;
    if (smeterobj) smeterobj.style.width = (s * 0.0191667) + "px";

    // Пик (PK)
    smeterpeaktimer--;
    if (smeterpeak < s - 0.1 || smeterpeaktimer <= 0) {
        smeterpeak = s;
        smeterpeaktimer = 20; // ← ЭТО ТАЙМЕР ПИКОВ
        if (smeterpeakobj) smeterpeakobj.style.width = (s * 0.0191667) + "px";
        if (numericalsmeterpeakobj) numericalsmeterpeakobj.innerHTML = dbText;
    }

    // 5. Расчет шума (NS) и SNR (строго по смыслу твоих переменных)
    smetermintimer--;
    // Если сигнал упал ниже текущего минимума или кончилось окно замера
    if ((s - 100 < smetermin) || (smetermintimer <= 0)) {
        smetermin = s;
        // Используем fmode и оригинальные таймеры: 0.2, 400, 800, 1600
        smetermintimer = (smetermin === 0) ? 0.2 : (fmode === "cw" ? 400 : (fmode === "am" ? 800 : 1600));
        
        // Пересчитываем noise для вывода (строго по частоте КВ/УКВ)
        noise = (freq < 30000 ? smetermin / 100 - 127 : smetermin / 100 - 147).toFixed(1);
    }
    // Расчет SNR (строго по оригиналу)
    snr = Math.round((smeterpeak - smetermin) / 100);

    // Вывод в HTML (используем ID из твоего индекса)
    var ndig = document.getElementById("ndig");
    if (ndig) ndig.innerHTML = (noise > -100 ? "&nbsp;" : "") + noise;

    var snrdig = document.getElementById("snrdig");
    if (snrdig) {
        snrdig.classList.remove("text-green", "text-yellow", "text-grey");
        if (snr <= 13) snrdig.classList.add("text-grey");
        else if (snr <= 19) snrdig.classList.add("text-yellow");
        else snrdig.classList.add("text-green");
        snrdig.innerHTML = (snr <= 9) ? "0" + snr : snr;
    }

    // 6. Текстовая шкала (Points) - убираем "скачки"
    if (pointsobj) {
        var a = '<span class="text-green tabular-nums">', red = '<span class="text-red tabular-nums">', yellow = '<span class="text-yellow tabular-nums">dB</span>';
        var off = '<span class="digit-off tabular-nums">+10</span><span class="digit-off tabular-nums">&nbsp;dB</span>';
        var r = "";

        if (s > th40 + 500)     r = red + "OVERLOAD</span>";
        else if (s > th40)      r = a + "S9</span> " + red + "+40</span> " + yellow;
        else if (s > 8400)      r = a + "S9</span> " + red + "+30</span> " + yellow;
        else if (s > 7400)      r = a + "S9</span> " + red + "+20</span> " + yellow;
        else if (s > 6400)      r = a + "S9</span> " + red + "+10</span> " + yellow;
        else if (s > 5400)      r = a + "S9</span> " + off;
        else if (s > 4800)      r = a + "S8</span> " + off;
        else if (s > 4200)      r = a + "S7</span> " + off;
        else if (s > 3600)      r = a + "S6</span> " + off;
        else if (s > 3000)      r = a + "S5</span> " + off;
        else if (s > 2400)      r = a + "S4</span> " + off;
        else if (s > 1800)      r = a + "S3</span> " + off;
        else if (s > 1200)      r = a + "S2</span> " + off;
        else if (s > 600)       r = a + "S1</span> " + off;
        else                    r = a + "S0</span> " + off;
        pointsobj.innerHTML = r;
    }

    // 7. Индикатор RX (Используем smetermin для порога)
    var rx = document.getElementById('rx_info');
    var isSignal = (s > smetermin + 200); 
    if (rx) {
        rx.classList.remove('digit-off-rx', 'digit-on-rx', 'digit-plus-rx');
        if (s > 6400) rx.classList.add('digit-plus-rx');
        else if (isSignal) rx.classList.add('digit-on-rx');
        else rx.classList.add('digit-off-rx');
    }

    // 8. Кубики (Squelch) - Обновленная трехцветная логика
    var canShowBars = (lastsquelch == 0 || isSignal || s > 6400);
    var ths = [600, 1200, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6400, 7400, 8400, th40];
    var ids = ["sm-s1", "sm-s2", "sm-s3", "sm-s4", "sm-s5", "sm-s6", "sm-s7", "sm-s8", "sm-s9", "sm-p10", "sm-p20", "sm-p30", "sm-p40"];

    for (var i = 0; i < ids.length; i++) {
        var b = document.getElementById(ids[i]);
        if (b) {
            if (canShowBars && s > ths[i]) {
                // Если кубик преодолел порог — включаем соответствующий цвет
                if (i < 7) { 
                    b.className = "sm-cube is-on-green";   // 0-6 (S1 - S7)
                } else if (i < 9) { 
                    b.className = "sm-cube is-on-yellow";  // 7-8 (S8 - S9)
                } else { 
                    b.className = "sm-cube is-on-red";     // 9-14 (+10 - +60)
                }
            } else {
                // Сигнал ниже порога — кубик выключен
                b.className = "sm-cube is-off";
            }
        }
    }
    
        // 8.5. Индикатор перегрузки OVERLOAD
    var overloadEl = document.getElementById('overload_info');
    if (overloadEl) {
        // Порог перегрузки чуть выше +60, например 11900 (можно подстроить)
        var isOverload = (s > th40 + 500);
        if (isOverload) {
            overloadEl.classList.remove('digit_off');
            overloadEl.classList.add('digit_on_red');  // используем красный цвет как для REC
        } else {
            overloadEl.classList.remove('digit_on_red');
            overloadEl.classList.add('digit_off');
        }
    }

    // 9. Системная проверка сервера (из твоего файла)
    if (serveravailable < 0) test_serverbusy();
}

var uu_names=new Array();
var uu_bands=new Array();
var uu_freqs=new Array();
var uu_infos = new Array;
var others_colours = ["#c3e82f", "#00a0a0", "#1aff74", "#ff2727", "#ffc90e", "#ff4db0", "#80ff00", "#0ca6e5", "#0080ff", "#b04dff", "#FF0D0D", "#00FF00", "#2F00FF", "#FF00FF", "#00FFFF", "#FFD300", "#BE0EFF", "#39FF14", "#FF1493", "#7DF9FF"];
var dxs=[];

function uu(e, t, s, a) {
    uu_names[e] = t, uu_bands[e] = s, uu_freqs[e] = a, uu_infos[e] = t
}

function uu1(e, t) {
    uu_freqs[e] = t
}

var uu_compactview=false;

function douu() {
    // ==========================================================================
    // САНИТАРНАЯ ОЧИСТКА: Удаляем старые тултипы из DOM перед перерисовкой
    // ==========================================================================
    if (typeof bootstrap !== 'undefined' && typeof bootstrap.Tooltip === 'function') {
        var oldTriggers = document.querySelectorAll('.userfreqbtn');
        for (var k = 0; k < oldTriggers.length; k++) {
            var inst = bootstrap.Tooltip.getInstance(oldTriggers[k]);
            if (inst) { 
                inst.dispose();
            }
        }
        var orphans = document.querySelectorAll('.tooltip');
        for (var k = 0; k < orphans.length; k++) {
            orphans[k].remove();
        }
    }

    // ==========================================================================
    // ОСНОВНАЯ ЛОГИКА ОТРИСОВКИ (ОРИГИНАЛЬНАЯ, БЕЗ ВЫДЕЛЕНИЯ "СЕБЯ")
    // ==========================================================================
    s = "";
    var e, t, a = (total = 0),
        n = 0;
    l = document.getElementById("usersmax"),
    l1 = document.getElementById("usersmax1");
    d = document.getElementById("numusers1"),
        m = document.getElementById("usercallsign").innerHTML = document.usernameform.username.value;
    u = '<span style="color: rgba(0,0,0,0);">0</span>';
    
    for (b = 0; b < nbands; b++) {
        if (uu_compactview) {
            // Компактный режим
            s += '<p><div align="left" style="width:1024px;height:15px;position:relative;">';
            for (let i = 0; i < uu_names.length; i++) {
                if (uu_bands[i] === b && uu_names[i]) {
                    const leftPos = 1024 * uu_freqs[i];
                    const color = others_colours[i % others_colours.length];
                    s += `<div id="user${i}" style="position:absolute;top:1px;left:${leftPos}px;width:1px;height:13px;background-color:${color};"></div>`;
                    total++;
                }
            }
            s += `</div><div style="width:1024px;height:13px;position:relative;"><img class="users-band" src="${bi[b].scaleimgs[0][0]}"></div></p>`;
        }
        else {
            // Стандартный режим отрисовки
            s += '<p><div id="userfield" align="left" style="width:1024px;"><div class="others">';
            
            for (i = 0; i < uu_names.length; i++) {
                if (uu_bands[i] == b && uu_names[i] != "") {
                    center_band_freq = bandinfo[b].centerfreq - bandinfo[b].samplerate / 2;
                    uufr = uu_freqs[i] * bandinfo[b].samplerate + center_band_freq;
                    e = uu_freqs[i] * bandinfo[b].samplerate + center_band_freq;
                    t = 1024 * uu_freqs[i] - 250;
                    band_name = bandinfo[b].name;
                    user_num = i + 1;
                    
                    // ИСПРАВЛЕНО: Используем others_colours.length вместо жёстко зашитого 20
                    user_color = others_colours[i % others_colours.length];
                    
                    // Определение модуляции
                    modes = (function(b) {
                        if (b === 0 || b === 1) return 'FM';
                        else if (b === 3 || b === 4) return 'USB';
                        else if (b === 5 || b === 6) return 'LSB';
                        else if (b === 7) return 'AM';
                        else return 'FM';
                    })(b);
                    
                    // ИСПРАВЛЕНО: Убрано выделение "себя" (isMe, me-user, #ffb703)
                    // Все пользователи окрашиваются из массива others_colours
                    div_users = '<div id="user' + i + '" align="center" style="position:relative; left:' + t + 'px; width:500px; color:' + user_color + ';">';
                    
                    button_users = '<button type="button" id="userinfo" class="userfreqbtn" onclick="setfreqb(' + e.toFixed(2) + '); set_mode(\'' + modes + '\');" data-bs-toggle="tooltip" data-bs-html="true" data-bs-placement="bottom" user-title="#' + user_num + '&nbsp;Диапазон:&nbsp;' + band_name + '  Частота:&nbsp;' + uufr.toFixed(2).slice(0, -6) + '.' + uufr.toFixed(2).substr(-6, 3) + '&nbsp;kHz (' + modes + ')  Пользователь:&ensp;' + uu_infos[i] + '" style="margin:0; padding:0 4px; color:' + user_color + ';">' + uu_names[i] + '</button>';
                    
                    s += div_users + button_users + "</div>";
                    total++;
                }
            }
            s += '<img class="users-band" src="' + bi[b].scaleimgs[0][0] + '"></div></div></p>';
        }
    }
    
    usersobj.innerHTML = s;
    9 < total ? (numusersobj.innerHTML = total) : (numusersobj.innerHTML = u + total),
    9 < uu_names.length ? (l.innerHTML = uu_names.length) : (l.innerHTML = "0" + uu_names.length),
    d.innerHTML = 9 < total ? total : "0" + total;
    
    // Восстанавливаем обновление второго счётчика пользователей (numusers2)
    var num2 = document.getElementById("numusers2");
    if (num2) num2.innerHTML = (total > 9) ? total : "0" + total;
    
    9 < uu_names.length ? (l1.innerHTML = uu_names.length) : (l1.innerHTML = "0" + uu_names.length);

    // ==========================================================================
    // ИНИЦИАЛИЗАЦИЯ ТУЛТИПОВ BOOTSTRAP 5 НА ЛЕТУ ПРИ КАЖДОЙ ПЕРЕРИСОВКЕ
    // ==========================================================================
    if (typeof bootstrap !== 'undefined' && typeof bootstrap.Tooltip === 'function') {
        var tooltipTriggerList = [].slice.call(document.querySelectorAll('.userfreqbtn'));
        tooltipTriggerList.map(function (tooltipTriggerEl) {
            var ut = tooltipTriggerEl.getAttribute('user-title');
            if (ut) {
                tooltipTriggerEl.setAttribute('data-bs-title', ut);
            }
            return new bootstrap.Tooltip(tooltipTriggerEl, {
                html: true,
                boundary: document.body
            });
        });
    }
}

function setcompactview(c)
{
   uu_compactview=c;
   douu();
}

function ajaxFunction3()
{
  var xmlHttp;
  try { xmlHttp=new XMLHttpRequest(); }
    catch (e) { try { xmlHttp=new ActiveXObject("Msxml2.XMLHTTP"); }
      catch (e) { try { xmlHttp=new ActiveXObject("Microsoft.XMLHTTP"); }
        catch (e) { alert("Your browser does not support AJAX!"); return false; } } }
  xmlHttp.onreadystatechange=function()
    {
    if(xmlHttp.readyState==4)
      {
        if (xmlHttp.status==200 && xmlHttp.responseText!="") {
          eval(xmlHttp.responseText);
          douu();
        }
        clearTimeout(interval_ajax3);
        interval_ajax3 = setTimeout('ajaxFunction3()',1000);
      }
    }
  interval_ajax3 = setTimeout('ajaxFunction3()',120000);
  var url="/~~othersjj?chseq="+chseq;
  xmlHttp.open("GET",url,true);
  xmlHttp.send(null);
}

function javatest()
{
   var javaversion;
   try {
      javaversion = soundapplet.javaversion();
   } catch(err) {
      javaerr=1;
      if (!usejavasound) return;
      document.getElementById("javawarning").style.display= "block";
      javaversion="999";
      setTimeout('javatest()',1000); // in case loading java was simply taking too long
   }
   if (javaversion<"1.4.2") {
      document.getElementById("javawarning").innerHTML='Your Java version is '+javaversion+', which is too old for the WebSDR. Please install version 1.4.2 or newer, e.g. from <a href="http://www.java.com">http://www.java.com</a> if you hear no sound.';
      document.getElementById("javawarning").style.display= "block";
   }
}

/**
 * ОБНОВЛЕНИЕ ПОЛОСЫ ПРОПУСКАНИЯ И РЕЖИМОВ (updbw)
 * 
 * Основные задачи:
 * 1. Управление границами фильтра (hi/lo) и предотвращение их перекрещивания.
 * 2. Ограничение ширины полосы согласно параметрам диапазона.
 * 3. Расчет и вывод значения полосы в кГц на цифровое табло.
 * 4. Определение базовой модуляции (fmode) для работы S-метра.
 * 5. Визуальное обновление кнопок режимов и LED-индикаторов на панели.
 */
function updbw() {
    // 1. Логика границ
    hi < lo && (document.onmousemove == useMouseXYloweredge || touchingLower ? lo = hi : hi = lo);
    
    // 2. Ограничение ширины
    var e_limit = ("FM" == mode) ? 15 : 1.875 * bandinfo[band].maxlinbw;
    lo < -e_limit && (lo = -e_limit);
    e_limit < hi && (hi = e_limit);
    
    // 3. Табло ширины
    var bw_obj = document.getElementById("numericalbandwidth6");
    if (bw_obj) {
        var bw_val = hi - lo + 0;
        bw_obj.innerHTML = (10 <= bw_val) ? bw_val.toFixed(2) : "0" + bw_val.toFixed(2);
    }

    // 4. Определение fmode (сохраняем присваивание r = mode, это важно для других функций!)
    r = mode; 
    if ("FM" == r || "FMW" == r || "FMN" == r || "FMV" == r) fmode = "fm";
    else if ("AM" == r || "AMW" == r || "AMN" == r || "AMV" == r) fmode = "am";
    else if ("LSB" == r || "LSBW" == r || "LSBN" == r || "LSBV" == r) fmode = "lsb";
    else if ("USB" == r || "USBW" == r || "USBN" == r || "USBV" == r) fmode = "usb";
    else if ("CW" == r || "CWW" == r || "CWN" == r || "CWV" == r) fmode = "cw";

    // 5. Обновление интерфейса (через оригинальные try-catch)
    try { document.getElementById("freq-mode").innerHTML = fmode; } catch (e) {}

    try {
        document.getElementById('btn-mode-' + mode).classList.add("active");
        var mode_list = ['AM','FM','USB','LSB','CW','AMN','FMN','USBN','LSBN','CWN'];
        for (var i = 0; i < mode_list.length; i++) {
            if (mode_list[i] != mode) document.getElementById("btn-mode-" + mode_list[i]).classList.remove("active");
        }
    } catch (e) {}

    try {
        var on_class = "digit_on", off_class = "digit-off-o";
        document.getElementById("digit-" + mode).classList.remove(off_class);
        document.getElementById("digit-" + mode).classList.add(on_class);
        var leds = ["CW", "LSB", "USB", "AM", "FM"];
        for (var j = 0; j < leds.length; j++) {
            if (leds[j] != mode) {
                document.getElementById("digit-" + leds[j]).classList.remove(on_class);
                document.getElementById("digit-" + leds[j]).classList.add(off_class);
            }
        }
    } catch (e) {}

    setfreq(freq);
    updateFilterIndicators();  // обновляем графический бейдж и SFT
}

/**
 * Отрисовывает форму фильтра на маленьком canvas.
 * lo, hi – границы в кГц. Диапазон отображения ±6 кГц (12 кГц всего).
 * Рисуем только линии – прозрачный фон, никакой заливки.
 */
/**
 * Отрисовка трапеции (наклонные ножки) + обновление SFT.
 */
function updateFilterIndicators() {
    // Только обновление SFT (смещение)
    var sftSpan = document.getElementById('sft-value');
    if (sftSpan) {
        var shift = (hi + lo) / 2;
        var shiftFormatted = shift.toFixed(2);
        if (shift >= 0) shiftFormatted = '+' + shiftFormatted;
        sftSpan.innerHTML = shiftFormatted;
    }
    // Отрисовка канваса УДАЛЕНА – ничего не делаем с canvas
}

/**
 * ПЕРЕКЛЮЧЕНИЕ ПРЕСЕТОВ ФИЛЬТРОВ (filter)
 * 
 * Обрабатывает нажатие на кнопки выбора ширины полосы (0, 1, 2, 3).
 * В зависимости от текущей модуляции (fmode), формирует команду для 
 * перехода на конкретный режим (Wide, Standard, Narrow или Variable) 
 * и передает её в функцию set_mode.
 */
function filter(e) {
    if ("fm" == fmode) {
        if (3 == e) set_mode("fmw");
        else if (2 == e) set_mode("fm");
        else if (1 == e) set_mode("fmn");
        else if (0 == e) set_mode("fmv");
    } 
    else if ("am" == fmode) {
        if (3 == e) set_mode("amw");
        else if (2 == e) set_mode("am");
        else if (1 == e) set_mode("amn");
        else if (0 == e) set_mode("amv");
    } 
    else if ("usb" == fmode) {
        if (3 == e) set_mode("usbw");
        else if (2 == e) set_mode("usb");
        else if (1 == e) set_mode("usbn");
        else if (0 == e) set_mode("usbv");
    } 
    else if ("lsb" == fmode) {
        if (3 == e) set_mode("lsbw");
        else if (2 == e) set_mode("lsb");
        else if (1 == e) set_mode("lsbn");
        else if (0 == e) set_mode("lsbv");
    } 
    else if ("cw" == fmode) {
        if (3 == e) set_mode("cww");
        else if (2 == e) set_mode("cw");
        else if (1 == e) set_mode("cwn");
        else if (0 == e) set_mode("cwv");
    }
}

// from http://www.quirksmode.org/js/cookies.html
function createCookie(name,value,days) {
	if (days) {
		var date = new Date();
		date.setTime(date.getTime()+(days*24*60*60*1000));
		var expires = "; expires="+date.toGMTString();
	}
	else var expires = "";
	document.cookie = name+"="+value+expires+"; path=/";
}

function readCookie(name) {
	var nameEQ = name + "=";
	var ca = document.cookie.split(';');
	for(var i=0;i < ca.length;i++) {
		var c = ca[i];
		while (c.charAt(0)==' ') c = c.substring(1,c.length);
		if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
	}
	return null;
}

function id2band(id)
{
   if (view == Views.oneband) return band; else return id;
}

function band2id(b)
{
   if (view == Views.oneband) return 0; else return b;
}

function waterfallspeed(sp)
{
   waterslowness=sp;
    updateActive('waterspeed', sp);
   if (waitingforwaterfalls>0) return;
   var done=0;
   if (view==Views.othersslow) {
      for (i=0;i<nwaterfalls;i++)
         if (i==band) waterfallapplet[i].setslow(sp);
         else waterfallapplet[i].setslow(100);
   } else {
      for (i=0;i<nwaterfalls;i++)
         waterfallapplet[i].setslow(sp);
   }
}

//НОВАЯ ФУНКЦИЯ
// Желтая полоска на высоту активного водопада
function updateVerticalStrip() {
    var vl = document.querySelector('.vl');
    if (!vl) return;

    // Определяем текущий режим отображения и индекс активного диапазона
    var activeBand = band; // глобальная переменная из websdr-base
    var isAllBands = (view === Views.allbands || view === Views.othersslow);
    
    var waterfallElement = null;
    if (isAllBands) {
        // В режиме All bands ищем контейнер водопада для активного band
        var wfDiv = document.getElementById('wfdiv' + activeBand);
        if (wfDiv) {
            waterfallElement = wfDiv.querySelector('canvas, applet, .waterfall-applet');
        }
    } else {
        // В режиме One band ищем любой водопад (он один)
        waterfallElement = document.querySelector('#waterfalls canvas, #waterfalls applet, .waterfall-applet');
    }
    
    if (!waterfallElement) {
        // Fallback: ищем любой элемент с высотой
        var falls = document.querySelectorAll('#waterfalls > div');
        for (var i = 0; i < falls.length; i++) {
            if (falls[i].offsetHeight > 0) {
                waterfallElement = falls[i];
                break;
            }
        }
    }
    if (!waterfallElement) return;
    
    // Вычисляем позицию верха водопада относительно родителя .vl
    var parent = vl.parentNode;
    var wfRect = waterfallElement.getBoundingClientRect();
    var parentRect = parent.getBoundingClientRect();
    var topOffset = wfRect.top - parentRect.top;
    var height = waterfallElement.offsetHeight + 20; // +20 для выступа вниз
    
    vl.style.position = 'absolute';
    vl.style.top = topOffset + 'px';
    vl.style.height = height + 'px';
    vl.style.bottom = 'auto';
}

function waterfallheight(si)
{
   waterheight=si;
    updateActive('waterheight', si);
   if (waitingforwaterfalls>0) return;
   for (i=0;i<nwaterfalls;i++) {
      waterfallapplet[i].setSize(1024,si);
   }
    // Даём время апплету применить размер
    setTimeout(function() { updateVerticalStrip(); }, 30);

   var y=scaleobj.offsetTop+15;
   passbandobj.style.top=y+"px";
   edgelowerobj.style.top=y+"px";
   edgeupperobj.style.top=y+"px";
   carrierobj.style.top=(y-15)+"px";
}

function waterfallmode(m)
{
   watermode=m;
    updateActive('watermode', m);
   if (waitingforwaterfalls>0) return;
   for (i=0;i<nwaterfalls;i++) {
      waterfallapplet[i].setmode(m);
   }
}

function soundappletstarted()
{
   if (usejavasound && javaerr) {
      javaerr=0;
      document.getElementById("javawarning").style.display= "none";
   }
   setTimeout('soundappletstarted2()',100);
}

function soundappletstarted2()
{
   allloadeddone=true;

   soundapplet.setvolume(Math.pow(10, document.getElementById('volumecontrol2').value /10.));

   if (bi[0]) {
      setfreqif(nominalfreq(freq));
      updbw();
   }

   try { setmute(document.getElementById('mutecheckbox').checked) } catch(e){};
   try { setsquelch(document.getElementById('squelchcheckbox').checked) } catch(e){};
   try { setautonotch(document.getElementById('autonotchcheckbox').checked) } catch(e){};

   test_serverbusy();
}

function waterfallappletstarted(id)
{
   // this function is called when a waterfall applet becomes active
   waitingforwaterfalls--;
   if (waitingforwaterfalls<0) waitingforwaterfalls=0; // shouldn't happen...
   if (waitingforwaterfalls!=0) return;
   setTimeout('allwaterfallappletsstarted()',100);
}

function allwaterfallappletsstarted() 
{
   var i;

   waterfallspeed(waterslowness);
   waterfallmode(watermode);

   for (i=0;i<nwaterfalls;i++) {
      var e=bi[i];
      waterfallapplet[i].setband(e.realband, e.maxzoom, e.zoom, e.start);
   }
   if (view==Views.oneband) {
      var e=bi[band];
      waterfallapplet[0].setband(band, e.maxzoom, e.zoom, e.start);
   }

   // and when the applets run, we can also be sure that the HTML elements for the frequency scale have been rendered:
   for (i=0;i<nwaterfalls;i++) {
     scaleobjs[i] = document.getElementById('clipscale'+i);
     scaleimgs0[i] = document.images["s0cale"+i];
     scaleimgs1[i] = document.images["s1cale"+i];
   }
   if (view==Views.oneband) {
      setscaleimgs(band,0);
      scaleobj = scaleobjs[0];
   } else {
      for (i=0;i<nwaterfalls;i++) setscaleimgs(i,i);
      scaleobj=scaleobjs[band];
   }
   draw_passband();
    updateVerticalStrip();  // добавляем эту строку
}

var sup_socket = !!window.WebSocket && !!WebSocket.CLOSING;   // the CLOSING test excludes browsers with an old version of the websocket protocol, in particular Safari 5
var sup_canvas = !!window.CanvasRenderingContext2D;
var sup_webaudio = window.AudioContext || window.webkitAudioContext;
var sup_mozaudio = false;
try { if (typeof(Audio)==='function' && typeof(new Audio().mozSetup)=='function') sup_mozaudio = true; } catch (e) {};

function html5javawarn()
{ 
   // show warning regarding support for HTML5 or Java if needed
   document.getElementById("javawarning").style.display= (usejavasound && javaerr) ? "block" : "none";
   document.getElementById("html5warning").style.display= (!usejavasound && !sup_webaudio && !sup_mozaudio) ? "block" : "none";
}

function html5orjava(item,usejava)
{
   if (item==0) {
      // waterfall
      if (usejavawaterfall==usejava) return;
      usejavawaterfall=usejava;
      var s=(usejavawaterfall?"y":"n")+(usejavasound?"y":"n");
      createCookie("usejava",s,3652);
      var i;
      try { for (i=0;i<nwaterfalls;i++) waterfallapplet[i].destroy(); } catch (e) {} ;
      document_waterfalls();
   }
   if (item==1) {
      // sound
      if (usejavasound==usejava) return;
      usejavasound=usejava;
      var s=(usejavawaterfall?"y":"n")+(usejavasound?"y":"n");
      createCookie("usejava",s,3652);
      try { soundapplet.destroy(); } catch (e) {};
      document_soundapplet();
      document.getElementById('record_span').style.display= usejavasound ? "none" : "inline";
      html5javawarn();
   }
}

function checkjava()
{
   try {
      if (navigator.javaEnabled && navigator.javaEnabled()) return "green";
   } catch(e) {};
   try {
      var m=navigator.mimeTypes;
      for (i=0;i<m.length;i++)
         if (m[i].type.match(/^application\/x-java-applet/)) return "green";
      return "red"; 
   } catch(e) {};
   return "black";
}

function iOS_audio_start()
{
   // Safari on iOS only plays webaudio after it has been started by clicking a button, so this function must be called from a button's onclick handler
   if (!document.ct) document.ct= new webkitAudioContext();
   var s = document.ct.createBufferSource();
   s.connect(document.ct.destination);
   try { s.start(0); } catch(e) { s.noteOn(0); }
}

function chrome_audio_start()
{
   // Chrome only plays webaudio after it has been started by clicking a button, so this function must be called from a button's onclick handler
   if (!document.ct) document.ct= new webkitAudioContext();
   var s = document.ct.createBufferSource();
   s.connect(document.ct.destination);
   document.ct.resume();
   try { s.start(0); } catch(e) { s.noteOn(0);}
}

//function set_buffer1(toggle)
//{
//	if(toggle==1) soundapplet.setdelay1(2000);
//    else if(toggle==2) soundapplet.setdelay1(4000);
//    else if(toggle==3) soundapplet.setdelay1(8000);
//    else if(toggle==4) soundapplet.setdelay1(16000);
//    else soundapplet.setdelay1(1000);		// original value
//}

function html5orjavamenu()
{
   var t;
   if (sup_webaudio) {
      if (sup_webaudio) {
         if (!document['ct']) document['ct']= new sup_webaudio;
         try {
            var cc=document['ct'].createConvolver;
         } catch (e) {
            document['ct']=null; // firefox 23 supports webaudio, but not yet createConvolver(), making it unusable.
            sup_webaudio=false;
         };
      }
   }
   sup_iOS = 0;   // global!
   sup_android = 0;   // global!
   sup_chrome = 0;  // global!
   try { 
      var n=navigator.userAgent.toLowerCase();
      if (n.indexOf('iphone')!=-1) sup_iOS=1;
      if (n.indexOf('ipad')!=-1) sup_iOS=1;
      if (n.indexOf('ipod')!=-1) sup_iOS=1;
      if (n.indexOf('ios')!=-1) sup_iOS=1;
      if (n.indexOf('android')!=-1) sup_android=1;
      if (n.indexOf('chrome')!=-1) sup_chrome=1;
   } catch (e) {};
   if (sup_iOS) isTouchDev=true;
   var usecookie= readCookie('usejava');
   if (!usecookie) {
      if (sup_socket && sup_canvas) usecookie="n"; else usecookie="y";
      if (sup_socket && (sup_webaudio || sup_mozaudio)) usecookie+="n"; else usecookie+="y";
   }
   usejavawaterfall=(usecookie.substring(0,1)=='y');
   usejavasound=(usecookie.substring(1,2)=='y');
    
    var t = "";
var javaDisabled = true;  // <-- поставьте false, чтобы включить Java-кнопки

// === ВОДОПАД ===
t += '<div class="wsdr-group">';
t += '<span class="wsdr-group-title">Водопад</span>';

// Java (водопад) — disabled
t += '<input type="radio" name="groupw" id="java-w" class="wsdr-hidden-input" autocomplete="off" onclick="html5orjava(0,1);"' 
    + (usejavawaterfall ? " checked" : "") 
    + (javaDisabled ? ' disabled' : '') 
    + '>';
t += '<label for="java-w" class="wsdr-btn' + (javaDisabled ? ' wsdr-btn-disabled' : '') + '">Java</label>';

// HTML5 (водопад) — активен
t += '<input type="radio" name="groupw" id="html-w" class="wsdr-hidden-input" autocomplete="off" onclick="html5orjava(0,0);"' 
    + (usejavawaterfall ? "" : " checked") 
    + '>';
t += '<label for="html-w" class="wsdr-btn">Html 5</label>';
t += '</div>';

// === ЗВУК ===
t += '<div class="wsdr-group">';
t += '<span class="wsdr-group-title">Звук</span>';

// Java (звук) — disabled
t += '<input type="radio" name="groupa" id="java-a" class="wsdr-hidden-input" autocomplete="off" onclick="html5orjava(1,1);"' 
    + (usejavasound ? " checked" : "") 
    + (javaDisabled ? ' disabled' : '') 
    + '>';
t += '<label for="java-a" class="wsdr-btn' + (javaDisabled ? ' wsdr-btn-disabled' : '') + '">Java</label>';

// HTML5 (звук) — активен
t += '<input type="radio" name="groupa" id="html-a" class="wsdr-hidden-input" autocomplete="off" onclick="html5orjava(1,0);"' 
    + (usejavasound ? "" : " checked") 
    + '>';
t += '<label for="html-a" class="wsdr-btn">Html 5</label>';

// === КНОПКА AUDIO (iOS/Browser) ===
var iaudio = sup_iOS && sup_socket && sup_webaudio ?
    '<button type="button" class="wsdr-btn wsdr-btn-action" title="Start iOS Audio" onclick="iOS_audio_start()"><i class="fab fa-apple"></i>&nbsp;Audio</button>' :
    '<button type="button" class="wsdr-btn wsdr-btn-action" title="Start Browser Audio" onclick="iOS_audio_start()">Start Audio</button>';

t += iaudio;
t += '</div>';

    document.getElementById('html5choice').innerHTML = t;
    document.getElementById('record_span').style.display = usejavasound ? "none" : "inline";
    }

function getLastParams() {
    readmodea = readCookie("last-mode-a");
}

//// Глобальные константы
const WSDR_COORDS = { 
    lat: 53.305664, 
    lon: 83.625451 
};

const GEO_TEMPLATE = ['country', 'city'];
//const GEO_TEMPLATE = ['country', 'regionName'];
//// Россия/Алтайский край/Барнаул
////const GEO_TEMPLATE = ['country', 'regionName', 'city']; 
//// Алтайский край/Барнаул
//const GEO_TEMPLATE = ['regionName', 'city'];
//// Барнаул, Россия
////const GEO_TEMPLATE = ['city', 'country'];
//
// Функцию-форматировщик
function formatGeoString(data) {
    return GEO_TEMPLATE
        .map(field => {
            const value = data[field];
            // Для поля 'country' используем полное название страны
            if (field === 'country' && data.countryCode) {
                return data.country || data.countryCode;
            }
            return value || null;
        })
        .filter(Boolean) // Убираем пустые значения
        .join('/')       // Соединяем через слэш
        || 'Unknown';    // Если все поля пустые
}

// Универсальная функция расчета расстояния
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Радиус Земли в км
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * 
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
        
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function getLocation() {
    //let geo = " ";
    const e = navigator.language || navigator.userLanguage;
    const lang = "en";
    const url = `http://ip-api.com/json/?fields=status,continent,country,countryCode,region,regionName,city,lat,lon,timezone,offset,isp,as,asname,reverse,mobile,proxy,hosting,query&lang=${lang}`;
    fetch(url)
    .then(response => {
        //console.log('HTTP Status:', response.status);
        // 1. Проверка статуса (200 = OK)
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        return response.json();
    })
    .then(data => {
        //console.log('Данные API:', data);
        // 2. Формируем строку какую необходимо
        geo = [data.countryCode, data.city].join(',');
        //console.log('Сформировано geo:', geo);
        // 3. Сохраняем оригинальное присвоение полю time
        document.getElementById('time').value = geo;
        // Расчет расстояния
        if (data.lat && data.lon) {
            const distance = calculateDistance(
                data.lat, 
                data.lon,
                WSDR_COORDS.lat,
                WSDR_COORDS.lon
            );
            // Формируем строку для usrgeo (добавляем этот блок)
//            const userGeo = [
//                data.country || 'Unknown', 
//                data.regionName || data.city || 'Unknown'
//            ].join('/');
            const userGeo = formatGeoString(data);

            const usrGeoElement = document.getElementById('usrgeo');
            if (usrGeoElement) {
                usrGeoElement.textContent = userGeo;
            }

            const distElement = document.getElementById('dist');
            const distElement1 = document.getElementById('dist1');
            if (distElement) {
                distElement.textContent = `Расстояние до WebSDR: ~ ${distance} км`;
            }
            if (distElement1) {
                distElement1.textContent = distance; 
            }
        }
    })
    .catch(error => {
        //console.error('Произошла ошибка:', error);
        // 4. Обработка ошибок
        //geo = " ";
        //document.getElementById('time').value = geo;
        document.getElementById('time').value = (" ");
        
    })
    .finally(() => {
        // 5. Сохраняем таймаут 1400 мс
        setTimeout(() => {
            document.usernameform.username.value = document.getElementById('time').value;
        }, 1400);
    });
}



function bodyonload()
{
    getLocation();
    getLastParams();
    var s;
    html5orjavamenu();
    if ((sup_iOS || sup_android) && has_mobile) document.getElementById("mobilewarning").style.display = "block";

    view = readCookie('view');
    if (view == null) view = Views.oneband;
    else view = Number(view); // Гарантируем число для сравнения

    // Вторая секция
    // === ВЫБОР ВИДА (All bands / Others slow / One band / Off) ===
    s = '<div class="wsdr-group">';
    s += '<span class="wsdr-group-title">Вид</span>';

    if (nvbands >= 2) {
        s += '<input type="radio" name="group" id="radio-1" class="wsdr-hidden-input" autocomplete="off" onclick="setview(0);" ' + (view === 0 ? 'checked' : '') + '>';
        s += '<label for="radio-1" class="wsdr-btn">All bands</label>';

        s += '<input type="radio" name="group" id="radio-4" class="wsdr-hidden-input" autocomplete="off" onclick="setview(1);" ' + (view === 1 ? 'checked' : '') + '>';
        s += '<label for="radio-4" class="wsdr-btn">Others slow</label>';

        s += '<input type="radio" name="group" id="radio-2" class="wsdr-hidden-input" autocomplete="off" onclick="setview(2);" ' + (view === 2 ? 'checked' : '') + '>';
        s += '<label for="radio-2" class="wsdr-btn">One band</label>';
    } else {
        if (view === Views.othersslow || view === Views.allbands) view = Views.oneband;
        s += '<input type="radio" name="group" id="radio-2" class="wsdr-hidden-input" autocomplete="off" onclick="setview(2);" ' + (view === 2 ? 'checked' : '') + '>';
        s += '<label for="radio-2" class="wsdr-btn">Waterfall</label>';
    }

    // Кнопка Off (общая)
    s += '<input type="radio" name="group" id="radio-3" class="wsdr-hidden-input" autocomplete="off" onclick="setview(3);" ' + (view === 3 ? 'checked' : '') + '>';
    s += '<label for="radio-3" class="wsdr-btn">Off</label>';
    s += '</div>';

    document.getElementById('viewformbuttons').innerHTML = s;
    if (nvbands >= 2) document.viewform.group[view].checked = true;
    else document.viewform.group[view - 2].checked = true;

    var x = readCookie('username');
    var p = document.getElementById("please2");
    if (!x && p) p.innerHTML="Ваш ник или позывной / Your nick or callsign";

    uu_compactview = document.getElementById("compactviewcheckbox").checked;
    document.getElementById("mutecheckbox").checked = false;
    document.getElementById("squelchcheckbox").checked = true;
    document.getElementById("autonotchcheckbox").checked = false;

    try {
        memories = JSON.parse(localStorage.getItem('memories'));
    } catch (e) {};
    if (!memories) memories = [];
    else {
        // conversion from old data format - should be removed later
        var rew = false;
        for (i = 0; i < memories.length; i++) {
            if (memories[i].mode == 1) {
                memories[i].mode = "AM";
                rew = true;
            }
            if (memories[i].mode == 4) {
                memories[i].mode = "FM";
                rew = true;
            }
            if (memories[i].mode == 0) {
                rew = true;
                if (memories[i].hi - memories[i].lo < 1) memories[i].mode = "CW";
                else if (memories[i].hi + memories[i].lo > 0) memories[i].mode = "USB";
                else memories[i].mode = "LSB";
            }
            if (!memories[i].nomfreq) memories[i].nomfreq = memories[i].freq + (memories[i].mode == "CW" ? 0.75 : 0);
        }
        if (rew) try {
            localStorage.setItem('memories', JSON.stringify(memories));
        } catch (e) {};
    }

    passbandobj = document.getElementById('yellowbar');
    passbandlineobj = document.getElementById('yellowbarr');
    edgeupperobj = document.getElementById('edgeupper');
    edgelowerobj = document.getElementById('edgelower');
    edgeupperobj = document.getElementById('edgeupper');
    carrierobj = document.getElementById('carrier');
    smeterobj = document.getElementById('smeterbar');
    numericalsmeterobj = document.getElementById('numericalsmeter');
    smeterpeakobj = document.getElementById('smeterpeak');
    smeterminobj = document.getElementById('smetermin');
    numericalsmeterpeakobj = document.getElementById('numericalsmeterpeak');
    pointsobj = document.getElementById("points");
    smeterobj.style.top = smeterpeakobj.style.top;
    smeterobj.style.left = smeterpeakobj.style.left;
    snrobj = document.getElementById('snr_info');
    try {
        const chatmsgobj = document.getElementById("chatmsgs");
        chatmsgobj.innerHTML = 0 < chatmsgs ? chatmsgs : "00";
    } catch (error) {}
    chat_prepare_challenge();
    mem_show();
    miscmode();
        bi = bandinfo;
    for (i = 0; i < nbands; i++) {
        var e = bi[i];
        e.realband = i;
        e.effcenterfreq = e.centerfreq;
        e.effsamplerate = e.samplerate;
        e.zoom = 0;
        e.start = 0;
        e.minzoom = 0;
    }

    document.freqform.frequency.value = freq;
    if (nbands > 1) document.freqform.group0[0].checked = true;

    html5javawarn();

    chatboxobj = document.getElementById('chatbox');
    statsobj = document.getElementById('stats');
    numusers2obj = document.getElementById('numusers2');
    numusers1obj = document.getElementById('numusers1');
    numusersobj = document.getElementById('numusers');
    usersobj = document.getElementById('users');
    setview(view);
    
    if (!islsbband(band) && hi<0) { var tmp=hi; hi=-lo; lo=-tmp; mode="USB"; }
    var tuneparam = new RegExp("[?&]tune=([^&#]*)").exec(window.location.href);
    if (tuneparam) {
        setfreqtune(tuneparam[1]);
    } else if (ini_freq && ini_mode) {
        setfreqif(ini_freq);
        set_mode(ini_mode);
    }
    setband(band);
    set_mode(mode);
    document_soundapplet();
    interval_ajax3 = setTimeout('ajaxFunction3()', 1000);
    setTimeout('javatest()', 2000);
    interval_updatesmeter = setInterval('updatesmeter()', 100);
    if (isTouchDev) {
        registerTouchEvents("carrier", touchpassband, touchXYpassband);
        registerTouchEvents("yellowbar", touchpassband, touchXYpassband);
        registerTouchEvents("edgeupper", touchupper, touchXYupperedge);
        registerTouchEvents("edgelower", touchlower, touchXYloweredge);
    }
}

function registerTouchEvents(id, touchStart, touchMove) {
   var elem=document.getElementById(id);
   elem.addEventListener('touchstart', touchStart);
   elem.addEventListener('touchmove', touchMove);
   elem.addEventListener('touchend', touchEnd);
}

function setusernamecookie() {
   createCookie('username',document.usernameform.username.value,365*5);
   var p=document.getElementById("please1");
   if (p) p.innerHTML="0";
   p=document.getElementById("please2");
   if (p) p.innerHTML="";
   send_soundsettings_to_server();
}

//----------------------------------------------------------------------------------------
// things related to interaction with the mouse (clicking & dragging on the frequency axes)

var dragging=false;
var dragorigX;
var dragorigval;
var touchingLower=false;

function getMouseXY(e)
{
   e = e || window.event;
   if (e.pageX || e.pageY) return {x:e.pageX, y:e.pageY};
   return {
     x:e.clientX + document.body.scrollLeft - document.body.clientLeft,
     y:e.clientY + document.body.scrollTop  - document.body.clientTop
   };
// from: http://www.webreference.com/programming/javascript/mk/column2/
}

//ПАТЧ 2026
function getScaleLeft() {
   if (!scaleobj) return 0;
   var rect = scaleobj.getBoundingClientRect();
   return rect.left + window.pageXOffset;
}

function useMouseXY(e)
{
   var pos=getMouseXY(e);
   setfreq((pos.x - getScaleLeft() - 512)*khzperpixel+centerfreq-(hi+lo)/2);
   return cancelEvent(e);
}

function touchXY(ev)
{
   ev.preventDefault();
   var scaleLeft = getScaleLeft();
   for (var i=0; i<ev.touches.length; i++) {
      var x = ev.touches[i].pageX;
      setfreq((x - scaleLeft - 512)*khzperpixel+centerfreq-(hi+lo)/2);
   }
}

function useMouseXYloweredge(e)
{
   var pos=getMouseXY(e);
   lo=dragorigval+(pos.x-dragorigX)*khzperpixel;
   updbw();
   return cancelEvent(e);
}

function touchXYloweredge(ev)
{
   ev.preventDefault();
   for (var i=0; i<ev.touches.length; i++) {
      var x = ev.touches[i].pageX;
      lo=dragorigval+(x-dragorigX)*khzperpixel;
      updbw();
   }
}

function useMouseXYupperedge(e)
{
   var pos=getMouseXY(e);
   hi=dragorigval+(pos.x-dragorigX)*khzperpixel;
   updbw();
   return cancelEvent(e);
}

function touchXYupperedge(ev)
{
   ev.preventDefault();
   for (var i=0; i<ev.touches.length; i++) {
      var x = ev.touches[i].pageX;
      hi=dragorigval+(x-dragorigX)*khzperpixel;
      updbw();
   }
}

function useMouseXYpassband(e)
{
   var pos=getMouseXY(e);
   setfreq(dragorigval+(pos.x-dragorigX)*khzperpixel);
   return cancelEvent(e);
}

function touchXYpassband(ev)
{
   ev.preventDefault();
   for (var i=0; i<ev.touches.length; i++) {
      var x = ev.touches[i].pageX;
      setfreq(dragorigval+(x-dragorigX)*khzperpixel);
   }
}

function mouseup(e)
{
   if (dragging) {
      dragging=false;
      document.onmousemove(e);
      document.onmousemove = null;
   }
}

function touchEnd(ev) {
   ev.preventDefault();
   if (dragging) {
      dragging=false;
      touchingLower=false;
   }
}

function imgmousedown(ev,bb)
{
   var b=id2band(bb);
   dragging=true;
   document.onmousemove = useMouseXY;
   if (view!=Views.oneband && band!=b) {
      if (view==Views.othersslow) waterfallspeed(waterslowness);
      setband(b);
      useMouseXY(ev);
   }
}

function imgtouch(ev) {
   ev.preventDefault();
   
   // recover waterfall instance number from event target
   // is there a better way to do this?
   var e = ev || window.event;
   var img;
   if (e.target) img = e.target; else
   if (e.srcElement) img = e.srcElement;
   if (img.nodeType == 3) img = img.parentNode;
   var bb=0;
   if (img.name) bb = img.name.substring(6,7); else	// name="sncale[bb]" from HTML below
   if (img.id) bb = img.id.substring(8,9);		// id="blackbar[bb]" from HTML below

   var b=id2band(bb);
   if (view!=Views.oneband && band!=b) {
      if (view==Views.othersslow) waterfallspeed(waterslowness);
      setband(b);
   }

   if (ev.targetTouches.length == 1) {
      dragging=true;
      dragorigX=ev.targetTouches[0].pageX;
      touchXY(ev);
   }
}

function mousedownlower(ev)
{
   var pos=getMouseXY(ev);
   dragging=true;
   document.onmousemove = useMouseXYloweredge;
   dragorigX=pos.x;
   dragorigval=lo;
   return cancelEvent(ev);
}

function touchlower(ev) {
   ev.preventDefault();
   if (ev.targetTouches.length == 1) {
      touchingLower=true;
      dragging=true;
      dragorigX=ev.targetTouches[0].pageX;
      dragorigval=lo;
   }
}

function mousedownupper(ev)
{
   var pos=getMouseXY(ev);
   dragging=true;
   document.onmousemove = useMouseXYupperedge;
   dragorigX=pos.x;
   dragorigval=hi;
   return cancelEvent(ev);
}

function touchupper(ev) {
   ev.preventDefault();
   if (ev.targetTouches.length == 1) {
      dragging=true;
      dragorigX=ev.targetTouches[0].pageX;
      dragorigval=hi;
   }
}

function mousedownpassband(ev)
{
   var pos=getMouseXY(ev);
   dragging=true;
   document.onmousemove = useMouseXYpassband;
   dragorigX=pos.x;
   dragorigval=freq;
   return cancelEvent(ev);
}

function touchpassband(ev) {
   ev.preventDefault();
   if (ev.targetTouches.length == 1) {
      dragging=true;
      dragorigX=ev.targetTouches[0].pageX;
      dragorigval=freq;
   }
}

function docmousedown(ev)
{
   var fobj;
   if (!ev) fobj=event.srcElement;  // IE
   else fobj = ev.target;  // FF
   if (fobj.className == "scale" || fobj.className=="scaleabs") return cancelEvent(ev);
   return true;
}

var tprevwheel=0;
var prevdir=0;
var wheelstep=1000;

function mousewheel(ev)
{
   var fobj;
   // Win7/IE9 seems to have fixed the problem where 'ev' is null if not called directly, i.e. mousewheel(event)
   if (!ev) { 
      ev=window.event; fobj=event.srcElement;	// IE
   }
   else fobj = ev.target;	// FF or IE9

   // In IE and Win7/Chrome the wheel event is not automatically passed on to the Java applet.
   // This check will handle the mouse wheel event for any browser running on Windows (not just IE and Chrome)
   // and hopefully that will not be a problem.
   if (navigator.platform.substring(0,3)=="Win" && fobj.tagName=='APPLET' && fobj.name.substring(0,15)=="waterfallapplet") {
         var pos=getMouseXY(ev);
         var rect = fobj.getBoundingClientRect();
         var x = pos.x - (rect.left + window.pageXOffset);
         // scrollwheel while on the waterfallapplet; only needed in IE/Chrome because FF always passes these events on to the java applet
         if (ev.wheelDelta>0) document[fobj.name].setzoom(-2, x);
         else if (ev.wheelDelta<0) document[fobj.name].setzoom(-1, x);
         return cancelEvent(ev);
   }

   // this is needed for Mac/Safari and {Mac,Linux,Win7}/Chrome when positioned on the text of a dx label
   if (fobj.nodeType==3) fobj=fobj.parentNode;	// 3=TEXT_NODE, i.e. text inside of a <div>

   if (fobj.className == "scale" || fobj.className=="scaleabs" || fobj.className.substring(0,8) == "statinfo") {
      // this is for tuning using the scroll wheel when positioned on the tuning scale
//      var delta = ev.deltaY ? ev.deltaY : ev.detail ? ev.detail : ev.wheelDelta/-40;
       var delta = ev.detail ? ev.detail : ev.wheelDelta/-40;
      var t=new Date().getTime();
      var dt=t-tprevwheel;
      if (dt<10) dt=10;
      tprevwheel=t;
      prevdir=delta; 
      if (Math.abs(delta)<wheelstep && delta!=0) wheelstep=Math.abs(delta);
      delta/=wheelstep;
      if (prevdir*delta>0 && dt<500) delta*=(500./dt);
      setfreq(freq-delta/100);
      event.preventDefault();
      return;
//      return cancelEvent(ev);
   }

   return true;
}

if (document.addEventListener) {
  window.addEventListener('DOMMouseScroll', mousewheel, false);
    // note: "modern" browsers are supposed to use this event, but it seems to be incompatible with the old ones, and for now we'll have t$
//  document.addEventListener('mousewheel', mousewheel, false);
//  document.addEventListener('wheel', mousewheel, false);    // note: "modern" browsers are supposed to use this event, but it seems to be incompatible with the old ones, and for now we'll have to$
    addEventListener('wheel', mousewheel, {passive: false}); // использовать колесы мыши
    addEventListener('mousewheel', mousewheel, {passive: false}); // использовать колесы мыши
  window.addEventListener('mouseup', mouseup, false);
  window.addEventListener('mousedown', docmousedown, false);
} else {
  window.onmousewheel = mousewheel;
  document.onmousewheel = mousewheel;
  document.onmouseup = mouseup;
  document.onmousedown = docmousedown;
}

//----------------------------------------------------------------------------------------
// direct control using keyboard:
var allowkeyboard;

function keydown(e)
{
   if (document.viewform.allowkeys && !document.viewform.allowkeys.checked);
   e = e ? e : window.event;
   if (!e.target) e.target = e.srcElement;
   if (e.target.nodeName=="INPUT" && e.target.type=="text" && e.target.name!="frequency") return true;  // don't intercept keys when typing in one of the text fields, except the frequency field
   var st=1;
   if (e.shiftKey) st=2;
   if (e.ctrlKey || e.altKey || e.metaKey) st=3;
   switch (e.keyCode) {
      case 37:                                                         // left arrow
      case 74: freqstep(-st);                return cancelEvent(e);    // J
      case 39:                                                         // right arrow
      case 75: freqstep(st);                 return cancelEvent(e);    // K
      case 65: setmf ('am',  -4  ,  4  );    return cancelEvent(e);    // A
      case 70: setmf ('fm',  -8  ,  8  );    return cancelEvent(e);    // F
      case 67: setmf ('cw', -0.95, -0.55);   return cancelEvent(e);    // C
      case 76: setmf('lsb', -2.7, -0.3);     return cancelEvent(e);    // L
      case 85: setmf('usb',  0.3,  2.7);     return cancelEvent(e);    // U
      case 90: if (e.shiftKey) wfset(2); else wfset(4); return cancelEvent(e);   // Z
      case 71: document.freqform.frequency.value=""; document.freqform.frequency.focus(); return cancelEvent(e);    // G
      case 66: if (e.shiftKey) setband((band-1+nbands)%nbands);        // B
               else setband((band+1)%nbands);  
               return cancelEvent(e);
   }
   return true;
}

window.onkeydown = keydown;

//----------------------------------------------------------------------------------------
// functions that create part of the HTML GUI

// Функции visit и newid 
function visit(tmpid) {
  if ( document.getElementById(tmpid).value == '') {
    document.getElementById(tmpid).value = document.getElementById(tmpid).value + " "+geo;
    document.usernameform.username.value = document.getElementById(tmpid).value;
  } else {
    document.getElementById(tmpid).value = document.getElementById(tmpid).value;
    document.usernameform.username.value = document.getElementById(tmpid).value;
  }
}

function newid(tmpid) {
  document.getElementById(tmpid).value = document.getElementById(tmpid).value + " "+geo;
  document.usernameform.username.value = document.getElementById(tmpid).value;
}

function document_username()
{
  var x= readCookie('username');
  if (x) {
    document.write('<span id="please">');
    document.write('<input type="text" id="visited" style="height: 25px; width: 150px;" class="form-control text-muted f14" name="username" maxlength="40" value="" ondragstart="return false" ondrop="return false" ondrag="return false" onpaste="return false" onblur="visit(this.id); setusernamecookie();" onclick=""></span>');
    document.addEventListener("keyup", function(event) { event.preventDefault(); if (event.keyCode == 13) {document.getElementById("visited").blur();}});
    document.usernameform.username.value=x;
  } else {
    document.write('<span id="please"><span id="please1"><b><i><\/i><\/b></span> ');
    document.write('<input type="text" id="time" style="height: 25px; width: 150px;" class="form-control text-muted f14" name="username" maxlength="40" ondragstart="return false" ondrop="return false" ondrag="return false" onpaste="return false" onfocus=this.value="" onblur="visit(this.id); setusernamecookie();" onclick=""></span>');
    document.addEventListener("keyup", function(event) { event.preventDefault(); if (event.keyCode == 13) {document.getElementById("time").blur();}});
  }
}


function document_waterfalls() 
{
  if (view==Views.allbands || view==Views.othersslow) nwaterfalls=nvbands;
  else if (view==Views.oneband) nwaterfalls=1;
  else { 
     nwaterfalls=0;
     document.getElementById('waterfalls').innerHTML="";
     return;
  }

  var i;
  var b;
  var s="";
  for (i=0;i<nwaterfalls;i++) {
    b = id2band(i);
    e=bi[b];
    j=e.realband;
    s+=
      '<div id="wfdiv'+i+'"></div>'+
      '<div class="scale" style="overflow:hidden; width:1024px; height:'+scaleheight+'px; position:relative" title="click to tune" id="clipscale'+i+'" onmousedown="return false">' +
        '<img src="'+e.scaleimgs[0]+'" onmousedown="imgmousedown(event,'+i+')" class="scaleabs" style="top:0px" name="s0cale'+i+'">' +
        '<img src="'+e.scaleimgs[0]+'" onmousedown="imgmousedown(event,'+i+')" class="scaleabs" style="top:0px" name="s1cale'+i+'">' +
      '</div>' +
      '<div class="scale" style="width:1024px;height:30px;background-color:black;position:relative;" id="blackbar'+i+'" title="click to tune" onmousedown="imgmousedown(event,'+i+')"><\/div>' +
      '\n';
     waterfallapplet[i]={};
     waterfallapplet[i].div='wfdiv'+i;
     waterfallapplet[i].id=i;
     waterfallapplet[i].band=b;
     waterfallapplet[i].maxzoom=bi[b].maxzoom;
  }

  waitingforwaterfalls=nwaterfalls;     // this must be before the next line, to prevent a race
  document.getElementById('waterfalls').innerHTML=s;

  if (usejavawaterfall) {
     if (typeof prep_javawaterfalls =="function") prep_javawaterfalls();
     else {
       script = document.createElement('script');
       script.src = 'websdr-javawaterfall.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  } else {
     if (typeof prep_html5waterfalls =="function") prep_html5waterfalls();
     else {
       script = document.createElement('script');
       script.src = 'websdr-waterfall.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  }

  for (i=0;i<nwaterfalls;i++) {
    scaleobjs[i] = document.getElementById('clipscale'+i);
    scaleimgs0[i] = document.images["s0cale"+i];
    scaleimgs1[i] = document.images["s1cale"+i];
    if (isTouchDev) {
       registerTouchEvents('clipscale'+i, imgtouch, touchXY);
       registerTouchEvents('blackbar'+i, imgtouch, touchXY);
    }
  }

}

//function document_bandbuttons() {
//    if (1 < nvbands)
//        for (var e = 0; e < nbands; e++) {
//            (bandinfo[e].centerfreq - bandinfo[e].samplerate / 2).toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1."),
//            (bandinfo[e].centerfreq + bandinfo[e].samplerate / 2).toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1.");
//            document.write('<span class="form-group-wf pr2" ><input type="radio" name="group0" id="band_button' + e + '" autocomplete="off" onclick="setband(' + e + ");('band" + e + '\');" /><div class="btn-group " style="margin-bottom: 2px;"><label for="band_button' + e + '" class="btn btn-xs btn-re-right active plr0" style="border: 1px solid rgba(0,0,0,.25);font-size: 10px;height: 19px; width: 22px;"><span class="fa fa-square text-darkgreen" style="font-size: 10px;"></span><span> </span></label><label for="band_button' + e + '" class="btn btn-outline-secondary btn-xs " style="border: 1px solid rgba(0,0,0,.25);font-size: 11px; height: 19px; width:69px">' + bandinfo[e].name + "</label></div></span>")
//        }
//}

function document_bandbuttons() {
    if (nvbands > 1) {
        for (let e = 0; e < nbands; e++) {
            document.write(`<label class="wsdr-band-group"><input type="radio" class="wsdr-band-radio" name="group0" id="band_btn_${e}" onchange="setband(${e})">
                    <span class="wsdr-band-led"></span><span class="wsdr-band-btn">${bandinfo[e].name}</span></label>`);
        }
    }
}

function document_soundapplet() {
  if (usejavasound) {
     if (typeof prep_javasound =="function") prep_javasound();
     else {
       script = document.createElement('script');
       script.src = 'websdr-javasound.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  } else {
     if (typeof prep_html5sound =="function") prep_html5sound();
     else {
       script = document.createElement('script');
       script.src = 'websdr-sound.js';
       script.type = 'text/javascript';
       document.body.appendChild(script);
     }
  }
}

//----------------------------------------------------------------------------------------
// recording

// Глобальные переменные для улучшенной записи
var rec_showtimer;      // оригинальный интервал, мы его отключим
var rec_downloadurl;
var recStartTime = null; // время начала записи
var recFreq = '';        // частота (для отображения)

// Функция получения текущей частоты в МГц
function getCurrentFrequencyMHz() {
    if (typeof nominalfreq === 'function') {
        var f = nominalfreq(); // в кГц
        if (!isNaN(f)) return (f / 1000).toFixed(3);
    }
    // fallback, если nominalfreq недоступна
    var e1 = document.getElementById('a-freq-1');
    var e2 = document.getElementById('a-freq-2');
    if (e1 && e2) return e1.innerText + '.' + e2.innerText;
    return '?.???';
}

// Форматирование миллисекунд в MM:SS
function formatDuration(ms) {
    var totalSec = Math.floor(ms / 1000);
    var mins = Math.floor(totalSec / 60);
    var secs = totalSec % 60;
    return mins.toString().padStart(2,'0') + ':' + secs.toString().padStart(2,'0');
}

// Обновление дисплея во время записи
function updateRecDisplay() {
    if (!recStartTime) return;
    var duration = Date.now() - recStartTime;
    var timeStr = formatDuration(duration);
    var kB = 0;
    if (typeof soundapplet !== 'undefined' && soundapplet.rec_length_kB) {
        kB = Math.round(soundapplet.rec_length_kB());
    }

    var freqMHz = recFreq; // уже сохранена в record_start

    var html = 
      '<div class="rec-active-panel">' +
        '<i class="fas fa-circle rec-dot"></i>' +
        '<span class="rec-active-label">REC</span>' +
        '<span class="rec-active-freq">' + freqMHz + ' МГц</span>' +
        '<span class="rec-active-sep">|</span>' +
        '<span class="rec-active-time">' + timeStr + '</span>' +
        '<span class="rec-active-sep">|</span>' +
        '<span class="rec-active-size">' + kB + ' kB</span>' +
      '</div>';

    var el = document.getElementById('reccontrol');
    if (el) el.innerHTML = html;
}

// Оригинальная функция record_show нам больше не нужна, 
// но оставим заглушку, чтобы не было ошибок при вызове из ядра
function record_show() {
    // ничего не делаем, управление через наш интервал
}

// Запуск записи
function record_start() {
    // Сброс URL предыдущей записи
    if (rec_downloadurl) {
        URL.revokeObjectURL(rec_downloadurl);
        rec_downloadurl = null;
    }
    // Запоминаем частоту на момент старта
    recFreq = getCurrentFrequencyMHz();
    recStartTime = Date.now();

    // Запускаем оригинальную запись (ваш код без изменений)
    soundapplet.rec_start();

    // Останавливаем оригинальный интервал record_show, если он был
    if (rec_showtimer) {
        clearInterval(rec_showtimer);
        rec_showtimer = null;
    }

    // Запускаем наш интервал обновления
    rec_showtimer = setInterval(updateRecDisplay, 250);
    updateRecDisplay(); // сразу показать
}

// Остановка записи и формирование стильного сообщения
function record_stop() {
    // Останавливаем наш интервал
    if (rec_showtimer) {
        clearInterval(rec_showtimer);
        rec_showtimer = null;
    }
    recStartTime = null;

    // Оригинальное завершение записи
    var res = soundapplet.rec_finish();

    // --- сборка WAV (ваш код без изменений) ---
    var wavhead = new ArrayBuffer(44);
    var dv = new DataView(wavhead);
    var i = 0;
    var sr = Math.round(res.sr);
    dv.setUint8(i++, 82); dv.setUint8(i++, 73); dv.setUint8(i++, 70); dv.setUint8(i++, 70);
    dv.setUint32(i, res.len + 44, true); i += 4;
    dv.setUint8(i++, 87); dv.setUint8(i++, 65); dv.setUint8(i++, 86); dv.setUint8(i++, 69);
    dv.setUint8(i++, 102); dv.setUint8(i++, 109); dv.setUint8(i++, 116); dv.setUint8(i++, 32);
    dv.setUint32(i, 16, true); i += 4;
    dv.setUint16(i, 1, true); i += 2;
    dv.setUint16(i, 1, true); i += 2;
    dv.setUint32(i, sr, true); i += 4;
    dv.setUint32(i, 2 * sr, true); i += 4;
    dv.setUint16(i, 2, true); i += 2;
    dv.setUint16(i, 16, true); i += 2;
    dv.setUint8(i++, 100); dv.setUint8(i++, 97); dv.setUint8(i++, 116); dv.setUint8(i++, 97);
    dv.setUint32(i, res.len, true);
    // --- конец WAV ---

    var wavdata = res.wavdata;
    wavdata.unshift(wavhead);
    var bb = new Blob(wavdata, { type: 'application/binary' });
    if (!bb) document.getElementById('recwarning').style.display = "block";
    rec_downloadurl = window.URL.createObjectURL(bb);
    if (rec_downloadurl.indexOf('http') >= 0) document.getElementById('recwarning').style.display = "block";

    var fname = '';
    try {
        fname = (new Date().toISOString()).replace(/\.[0-9]{3}/, "");
    } catch (e) {}
    fname = "websdr_recording_" + fname + "_" + nominalfreq().toFixed(1) + "kHz.wav";

    // === Стильное уведомление о завершении записи ===
var alertHtml = 
  '<div class="rec-finish-panel">' +
    '<i class="fas fa-file-audio rec-finish-icon"></i>' +
    '<div class="rec-finish-info">' +
      '<span class="rec-finish-title">Запись сохранена</span>' +
      '<span class="rec-finish-filename">' + fname + '</span>' +
    '</div>' +
    '<a href="' + rec_downloadurl + '" download="' + fname + '" class="wsdr-action-btn" style="text-decoration:none;">' +
      '<i class="fas fa-download me-1"></i> Скачать' +
    '</a>' +
    '<button type="button" class="btn-close rec-finish-close" onclick="this.parentElement.remove()" aria-label="Close"></button>' +
  '</div>';

document.getElementById('reccontrol').innerHTML = alertHtml;
}

// Обработчик кнопки записи (остаётся практически вашим, только подправлен под новые функции)
function record_click() {
    var e = document.getElementById("recbutton"),
        t = document.getElementById("rec_info"),
        s = "<span class=\"fa fa-square\"></span>&nbsp;&nbsp;Stop&nbsp;&nbsp;",
        a = "digit_on_mute",
        n = "digit-off-o";
    if (e.innerHTML == '<span class="text-white">' + s + "</span>") {
        // Останавливаем
        e.classList.remove("active");
        t.classList.remove(a);
        t.classList.add(n);
        e.innerHTML = '<span class="fa fa-circle"></span>&nbsp;&nbsp;Record';
        record_stop();
    } else {
        // Запускаем
        t.classList.remove(n);
        t.classList.add(a);
        e.classList.add("active");
        e.innerHTML = '<span class="text-white">' + s + "</span>";
        record_start();
    }
}

// Переменные для подсчета сообщений и статуса чата
let chatCount = 0;
let chatInterest = 1;
let chatActive = 0;
let chatSt = 0;
const oops = "❌";
let challengesum = 34;
let challengequick = 0;

// Функция для подготовки задачи (защита от спама)
function chat_prepare_challenge() {
    var e = 4 + Math.floor(20 * Math.random())
      , t = Math.floor(Math.random() * e)
      , s = e - t;
    challengequick = 0,
    setTimeout(function() {
        "" != document.chatform.sum.value && (challengequick = 1)
    }, 1200),
    document.getElementById("chatboxchallenge").innerHTML = t + " + " + s,
    challengesum = e
}

// Функция отправки сообщения в чат
function sendchat() {
  timeout_idle_restart();

  // Проверка решения задачи (если требуется)
  const sumInput = document.chatform.sum.value;
  if (sumInput != challengesum) {
    // Отображаем сообщение об ошибке, если задача решена неверно
    sysAlert(300, "Неверная сумма чисел, попробуйте еще раз.");
    document.chatform.sum.value = oops;
    return false;
  }

  var xmlHttp;
  try { xmlHttp=new XMLHttpRequest(); }
    catch (e) { try { xmlHttp=new ActiveXObject("Msxml2.XMLHTTP"); }
      catch (e) { try { xmlHttp=new ActiveXObject("Microsoft.XMLHTTP"); }
        catch (e) { sysAlert(500, "Your browser does not support AJAX!"); return false; } } } // Заменил alert на sysAlert
  var url="/~~chat";
  var msg=encodeURIComponent(document.chatform.chat.value);
  url=url+"?name="+encodeURIComponent(document.usernameform.username.value)+"&msg="+encodeURIComponent(document.chatform.chat.value);
  xmlHttp.open("GET",url,true);
  xmlHttp.send(null);
  document.chatform.chat.value="";

  // Подсчет сообщений (УБРАЛ ЗДЕСЬ, ПЕРЕНЕС В chatnewline)
  //chatCount++;
  //updateChatMessageCount();

    chatSt = 200; //Устанавливаем код статуса
    sysAlert(200, "Ваше сообщение отправлено успешно.");

  return false;
}

// Функция вставки частоты
function pastefreqchat() {
   var f=document.chatform.chat;
   var start = f.selectionStart;
   var end = f.selectionEnd;
   var v= Math.round(nominalfreq()*1000)/1000 +" kHz "+mode;
   f.value = f.value.slice(0,start) + v + f.value.slice(end);
   f.selectionStart = f.selectionEnd = start+v.length;
}

// Функция добавления новой строки в чат и подсчета сообщений
function chatnewline(s) {
    var o = document.getElementById('chatbox');
    if (!o) return;

    if (s[0] == '-') {
        // remove line from chatbox
        var div = document.createElement('div');
        div.innerHTML = s;
        s = div.innerHTML;
        var re = new RegExp('<br>' + s.substring(1).replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&") + '.*', 'g');
        o.innerHTML = o.innerHTML.replace(re, '<br>');

    } else {
        // add line to chatbox
        o.innerHTML += '<br>' + s + '\n';
        o.scrollTop = o.scrollHeight;

        // Подсчет сообщений
        chatCount++;
    }

  updateChatMessageCount(); //Вызываем обновление счетчика
}

//Функция обновления счетчика сообщений на странице
function updateChatMessageCount() {
        var s = chatCount;
        try {
            document.getElementById("chatmsgs").innerHTML = s < 10 ? "0" + s : s
        } catch (s) {}
}


// Функция очистки поля комментариев лога
function sendlogclear() {
  document.logform.comment.value="";
}

// Функция отправки лога - МОДИФИЦИРОВАННАЯ ВЕРСИЯ С СИСТЕМНЫМИ АЛЕРТАМИ
function sendlog() {
  // 1. УМНАЯ ПРОВЕРКА: Если поле позывного пустое, отменяем отправку и выводим красивую ошибку
  var callValue = document.logform.call.value.trim();
  if (callValue === "") {
      sysAlert(300, "Введите позывной перед отправкой!", "alerts-container");
      return false;
  }

  var xmlHttp;
  try { xmlHttp=new XMLHttpRequest(); }
    catch (e) { try { xmlHttp=new ActiveXObject("Msxml2.XMLHTTP"); }
      catch (e) { try { xmlHttp=new ActiveXObject("Microsoft.XMLHTTP"); }
        catch (e) { alert("Your browser does not support AJAX!"); return false; } } }
  
  var url="/~~loginsert";
  url=url
     +"?name="+encodeURIComponent(document.usernameform.username.value)
     +"&freq="+nominalfreq()
     +"&call="+encodeURIComponent(document.logform.call.value)
     +"&comment="+encodeURIComponent(document.logform.comment.value)
     ;
  xmlHttp.open("GET",url,true);
  xmlHttp.send(null);
  
  // Очищаем поля формы сразу после отправки
  document.logform.call.value="";
  document.logform.comment.value="";
  
  xmlHttp.onreadystatechange=function()
    {
    if(xmlHttp.readyState==4)
      {
      // Сохраняем твою оригинальную логику ответа
      document.logform.comment.value=xmlHttp.responseText;
      
      // 2. ВЫВОДИМ КРАСИВОЕ УВЕДОМЛЕНИЕ УСПЕХА В ЛОГБУК!
      sysAlert(200, "Запись успешно добавлена в логбук!", "alerts-container");
      }
    }
  setTimeout("document.logform.comment.value=''",1000);
  
  // ===== ОБНОВЛЕНИЯ IFRAME =====
  // Обновляем журнал после отправки (твоя проверенная логика)
  setTimeout(function() {
    var currentCount = document.getElementById('logCount') ? 
                      document.getElementById('logCount').value : 
                      (typeof loglines !== 'undefined' ? loglines : 20);
    document.getElementById("logbook-table").src = "/~~logbook?nr=" + currentCount;
  }, 1500); // Ждем 1.5 секунды, чтобы сервер успел обработать
  
  return false;
}

// ==========================================
// УНИВЕРСАЛЬНАЯ ФУНКЦИЯ АЛЕРТОВ (Чат + Логбук)
// ==========================================
// e = код статуса (200, 300, 500)
// messageText = текст сообщения
// targetID = ID контейнера ('chat-alert' или 'alerts-container'). По умолчанию 'chat-alert'.
function sysAlert(e, messageText, targetID = 'chat-alert') {
    let a = "info"; // default
    let s = messageText;
    let icon = "fa-info-circle"; // Иконка по умолчанию

    // Распределяем статусы, цвета и иконки
    if (e === 200) { a = "success"; icon = "fa-check-circle"; }
    else if (e === 300 || e === 400 || e === 600) { a = "warning"; icon = "fa-exclamation-triangle"; }
    else if (e === 500 || e === 900 || e === 910) { a = "danger"; icon = "fa-times-circle"; }

    const alertBox = document.getElementById(targetID); // Ищем нужный контейнер
    
    if (alertBox) {
        // Очищаем старые алерты перед выводом нового, чтобы они не копились горой
        alertBox.innerHTML = `
            <div class="alert alert-${a} alert-dismissible fade show mt-2 mb-0 text-start" role="alert">
                <i class="fas ${icon} me-2"></i> ${s}
                <button type="button" class="close" data-bs-dismiss="alert" aria-label="Close">
                    <span aria-hidden="true">&times;</span>
                </button>
            </div>`;
            
        // Автоматически скрываем алерт через 5 секунд (чтобы интерфейс сам очищался)
        setTimeout(() => {
            alertBox.innerHTML = '';
        }, 5000);
        
    } else {
        alert(messageText); // Фолбэк, если верстка сломана
    }
}

// Общая функция для обновления кнопок под водопадом
function updateActive(group, value) {
    // Удаляем active у всех кнопок группы
    document.querySelectorAll(`[data-group="${group}"]`).forEach(btn => {
        btn.classList.remove('active');
    });
    // Добавляем active к выбранной кнопке
    const activeBtn = document.querySelector(`[data-group="${group}"][data-value="${value}"]`);
    if(activeBtn) activeBtn.classList.add('active');
}

// Инициализация при загрузке
window.addEventListener('DOMContentLoaded', () => {
    updateActive('watermode', watermode);
    updateActive('waterheight', waterheight);
    updateActive('waterspeed', waterslowness);
});

// Поиск индекса диапазона (band), который покрывает заданную частоту
// Возвращает индекс в массиве bandinfo, либо -1, если диапазон не найден
function findBandForFrequency(freq) {
    // freq ожидается в кГц
    for (var i = 0; i < bandinfo.length; i++) {
        var low = bandinfo[i].centerfreq - bandinfo[i].samplerate / 2;
        var high = bandinfo[i].centerfreq + bandinfo[i].samplerate / 2;
        if (freq >= low && freq <= high) {
            return i;
        }
    }
    return -1;
}
// === НОВАЯ РЕАЛИЗАЦИЯ МОДАЛКИ РУЧНОГО ВВОДА ЧАСТОТЫ ===
document.addEventListener('DOMContentLoaded', function() {
    var freqDisplay = document.querySelector('.pro-giant-freq');
    if (!freqDisplay) return;
    
    // Инициализация тултипа
    freqDisplay.setAttribute('data-bs-toggle', 'tooltip');
    freqDisplay.setAttribute('data-bs-placement', 'bottom');
    freqDisplay.setAttribute('data-bs-title', 'Ввод частоты вручную');
    if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
        new bootstrap.Tooltip(freqDisplay);
    }

    // Получение текущей частоты
    function getCurrentFreq() {
        var freqInput = document.querySelector('input[name="frequency"]');
        if (freqInput && freqInput.value) {
            var val = parseFloat(freqInput.value);
            if (!isNaN(val)) return val;
        }
        var f1 = document.getElementById('freq-1')?.innerText || '0';
        var f2 = document.getElementById('freq-2')?.innerText || '000';
        var f3 = document.getElementById('freq-3')?.innerText || '00';
        return parseFloat(f1 + '.' + f2 + f3) || 0;
    }

    // Открытие модалки по клику на частоту
    freqDisplay.addEventListener('click', function(e) {
        if (e.target.closest('button, a, input')) return;
        var modalEl = document.getElementById('freqModal');
        if (!modalEl) return;
        var modal = new bootstrap.Modal(modalEl);
        modal.show();
        var input = document.getElementById('manualFreqInput');
        if (input) {
            input.value = getCurrentFreq().toFixed(2);
            setTimeout(function() { input.select(); }, 100);
        }
    });

    // === ФУНКЦИЯ ОБНОВЛЕНИЯ ПОДСКАЗКИ ДИАПАЗОНОВ ===
    function updateFreqHint() {
        var input = document.getElementById('manualFreqInput');
        var hintContent = document.getElementById('freqHintContent');
        var errorDiv = document.getElementById('freqError');
        
        if (!input || !hintContent) return;
        
        var val = parseFloat(input.value);
        if (errorDiv) errorDiv.style.display = 'none';
        
        var html = '';
        var currentBand = null;
        
        // Проверяем, попадает ли частота в диапазон
        if (!isNaN(val) && val > 0 && typeof bandinfo !== 'undefined') {
            for (var i = 0; i < bandinfo.length; i++) {
                var low = bandinfo[i].centerfreq - bandinfo[i].samplerate / 2;
                var high = bandinfo[i].centerfreq + bandinfo[i].samplerate / 2;
                if (val >= low && val <= high) {
                    currentBand = bandinfo[i].name;
                    break;
                }
            }
        }
        
        // Выводим ВСЕ диапазоны
        if (typeof bandinfo !== 'undefined') {
            for (var i = 0; i < bandinfo.length; i++) {
                var band = bandinfo[i];
                var low = (band.centerfreq - band.samplerate / 2).toFixed(0);
                var high = (band.centerfreq + band.samplerate / 2).toFixed(0);
                var isCurrent = (currentBand === band.name);
                
                html += '<div class="band-item' + (isCurrent ? ' active-band' : '') + '">' +
                        '<span class="band-name">' + band.name + '</span>' +
                        '<span class="band-range">' + low + ' – ' + high + ' кГц</span>' +
                        '</div>';
            }
        }
        
        hintContent.innerHTML = html || '<span class="hint-loading">Диапазоны не найдены</span>';
    }

    // Обработчик кнопки "Установить"
    var setBtn = document.getElementById('setFreqBtn');
    if (setBtn) {
        setBtn.addEventListener('click', function() {
            var input = document.getElementById('manualFreqInput');
            var errorDiv = document.getElementById('freqError');
            var errorText = document.getElementById('freqErrorText');
            
            if (!input) return;
            
            var val = parseFloat(input.value);
            if (errorDiv) errorDiv.style.display = 'none';
            
            if (isNaN(val) || val <= 0) {
                if (errorText) errorText.textContent = 'Введите корректную частоту';
                if (errorDiv) errorDiv.style.display = 'block';
                return;
            }
            
            var bandIndex = (typeof findBandForFrequency === 'function') ? findBandForFrequency(val) : -1;
            if (bandIndex === -1) {
                if (errorText) errorText.textContent = 'Частота вне обслуживаемых диапазонов';
                if (errorDiv) errorDiv.style.display = 'block';
                return;
            }
            
            if (typeof setfreqb === 'function') {
                setfreqb(val);
            } else {
                if (errorText) errorText.textContent = 'Ошибка установки частоты';
                if (errorDiv) errorDiv.style.display = 'block';
                return;
            }
            
            var modalEl = document.getElementById('freqModal');
            if (modalEl && typeof bootstrap !== 'undefined') {
                bootstrap.Modal.getInstance(modalEl).hide();
            }
        });
    }

    // Обработчики ввода и клавиши Enter
    var manualInput = document.getElementById('manualFreqInput');
    if (manualInput) {
        manualInput.addEventListener('input', updateFreqHint);
        manualInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (setBtn) setBtn.click();
            }
        });
    }

    // События самой модалки
    var modalEl = document.getElementById('freqModal');
    if (modalEl) {
        modalEl.addEventListener('shown.bs.modal', function() {
            updateFreqHint();
        });
        modalEl.addEventListener('hidden.bs.modal', function() {
            var errorDiv = document.getElementById('freqError');
            if (errorDiv) errorDiv.style.display = 'none';
        });
    }
});