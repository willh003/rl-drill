// Learnmax -- the window.
//
// This file is the source for LearnmaxDrill.app, which drill.py compiles with
// osacompile and launches with `open`. It also runs directly for development:
//   osascript -l JavaScript drill_ui.js        (with DRILL_PAYLOAD set)
//
// Three macOS constraints shaped this, all of them found the hard way:
//
// 1. Not Tkinter. The system Tk (8.5) that /usr/bin/python3 links against
//    refuses to start on macOS 26 -- its Aqua init demands a host binary built
//    for 26.x, and the Command Line Tools python3 is built against the 14.4
//    SDK, so Tk() dies with SIGABRT before a window exists. pip and venv are
//    ruled out, so there is no Python-side fix.
//
// 2. Not CALayer. Assigning a CGColorRef through the JXA bridge
//    (layer.backgroundColor = c.CGColor) crashes with EXC_ARM_PAC_FAIL inside
//    -[CALayer setBackgroundColor:]; the bridge mangles the pointer. NSBox
//    takes plain NSColor objects for fill and border instead. Do not
//    "simplify" this back to layers.
//
// 3. Not a bare osascript process. macOS will not give one the keyboard when
//    launchd is the parent: the window appears (NSFloatingWindowLevel) but
//    isActive and isKeyWindow stay false, so 1-4 go to whatever app the user
//    was in. Only an app launched through LaunchServices gets focus, hence the
//    compiled applet. A shell script inside a hand-made .app does not work
//    either -- exec'ing osascript makes osascript the main executable and the
//    bundle identity is lost.
//
// 4. The card text is typeset by a WKWebView showing webapp/card.html (KaTeX,
//    vendored). AppKit cannot draw math. The web view is display-only: it
//    refuses first responder so the keys keep going to DrillRoot, and every
//    button is native, as before. Math is the only reason it is here.
//
// drill.py owns all the scheduling. This file owns pixels and keystrokes, and
// appends one JSON line per answer to the results file as it goes, so grading
// is persisted while the session runs rather than only at the end.

ObjC.import('Cocoa');
ObjC.import('WebKit');

// ---------------------------------------------------------------- plumbing

function argList() {
    return ObjC.unwrap($.NSProcessInfo.processInfo.arguments)
        .map(function (a) { return ObjC.unwrap(a); });
}

function env(name) {
    var v = $.NSProcessInfo.processInfo.environment.objectForKey(name);
    return v.isNil() ? null : ObjC.unwrap(v);
}

// Where cards.json and friends live. As an applet the bundle sits in that
// directory; run directly, the script path points at it.
function baseDir() {
    var bp = ObjC.unwrap($.NSBundle.mainBundle.bundlePath) || '';
    if (/\.app$/.test(bp)) return bp.replace(/\/[^\/]+\.app$/, '');
    var args = argList();
    for (var i = 0; i < args.length; i++) {
        if (/drill_ui\.js$/.test(args[i])) {
            var d = args[i].replace(/\/[^\/]+$/, '');
            // A bare filename (script run from its own directory) has no
            // slash to strip, so fall back to the working directory.
            if (d === args[i]) d = ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
            return d;
        }
    }
    return ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
}

var DIR = baseDir();
var PAYLOAD_PATH = env('DRILL_PAYLOAD') || (DIR + '/.drill-payload.json');
var RESULTS_PATH = env('DRILL_RESULTS') || (DIR + '/.drill-results.jsonl');
var SNAPSHOT = env('DRILL_SNAPSHOT');   // render frames to PNG, then quit

function emit(obj) {
    // Every line carries the session it belongs to, so drill.py can ignore
    // anything written by a window that is still shutting down.
    obj.s = SESSION;
    var data = $.NSString.alloc.initWithUTF8String(JSON.stringify(obj) + '\n')
        .dataUsingEncoding($.NSUTF8StringEncoding);
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(RESULTS_PATH)) {
        fm.createFileAtPathContentsAttributes(RESULTS_PATH, $(), $());
    }
    var fh = $.NSFileHandle.fileHandleForWritingAtPath(RESULTS_PATH);
    if (fh.isNil()) return;
    fh.seekToEndOfFile;
    fh.writeData(data);
    fh.closeFile;
}

function readJSON(path) {
    if (!path) return null;
    var s = $.NSString.stringWithContentsOfFileEncodingError(
        path, $.NSUTF8StringEncoding, $());
    if (s.isNil()) return null;
    try { return JSON.parse(ObjC.unwrap(s)); } catch (e) { return null; }
}

// ------------------------------------------------------------------ colour

function rgb(r, g, b) {
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(r / 255, g / 255, b / 255, 1.0);
}
var BG = rgb(28, 28, 30);
var ROW = rgb(38, 38, 41);
var FG = rgb(242, 242, 247);
var MUTED = rgb(142, 142, 147);
var LINE = rgb(58, 58, 60);
var GREEN = rgb(48, 209, 88);
var RED = rgb(255, 69, 58);

// Modern macOS NSTextAlignment follows UIKit ordering: left 0, centre 1.
var LEFT = 0, CENTER = 1;
var BOX_CUSTOM = 4, NO_TITLE = 0;

var W = 760, H = 680;
var PAD = 40;
var BTN_Y = 44, BTN_H = 56, BTN_GAP = 14;
var FOOT_Y = 112;
var WEB_Y = 140, WEB_TOP = 70;        // web view spans WEB_Y .. H - WEB_TOP
var PROMPT_MID = 380;                 // the closing line is centred on this

var F_KICKER = $.NSFont.systemFontOfSizeWeight(11, $.NSFontWeightSemibold);
var F_PROMPT = $.NSFont.systemFontOfSizeWeight(28, $.NSFontWeightMedium);
var F_BTN = $.NSFont.systemFontOfSizeWeight(16, $.NSFontWeightSemibold);
var F_SUB = $.NSFont.systemFontOfSizeWeight(12, $.NSFontWeightRegular);
var F_FOOT = $.NSFont.systemFontOfSizeWeight(12, $.NSFontWeightRegular);

// ------------------------------------------------------------------ widgets

function label(text, frame, font, color, align, wrap) {
    var t = $.NSTextField.alloc.initWithFrame(frame);
    t.bezeled = false;
    t.drawsBackground = false;
    t.editable = false;
    t.selectable = false;
    t.font = font;
    t.textColor = color;
    t.alignment = align;
    if (wrap) {
        t.usesSingleLineMode = false;
        t.cell.wraps = true;
        t.cell.lineBreakMode = 0;     // NSLineBreakByWordWrapping
    }
    t.stringValue = text;
    return t;
}

// --------------------------------------------------------------- subclasses

// Forward declarations, so the ObjC method bodies can reach them.
var act = function () {};
var quit = function () {};
var settle = function () {};
var grabFocus = function () {};

// What a button or key means. Tags double as the NSButton tags.
var STILL = 0, GOT = 1, SHOW = 2, REMOVE = 3;

ObjC.registerSubclass({
    name: 'DrillRoot',
    superclass: 'NSView',
    methods: {
        'acceptsFirstResponder': {
            types: ['bool', []],
            implementation: function () { return true; }
        },
        'keyDown:': {
            types: ['void', ['id']],
            implementation: function (ev) {
                // Match on both the hardware key code and the character. The
                // JXA bridge is not dependable about either one alone.
                var code = ev.keyCode;
                if (code === 53) { quit('escape'); return; }      // Escape
                if (code === 7) { act(REMOVE); return; }          // x
                if (code === 49 || code === 36 || code === 76) {  // space, return, enter
                    act(SHOW); return;
                }
                var byCode = { 18: STILL, 19: GOT,                // 1, 2
                               83: STILL, 84: GOT,                // keypad
                               123: STILL, 124: GOT };            // left, right
                if (byCode[code] !== undefined) { act(byCode[code]); return; }
                var ch = ObjC.unwrap(ev.charactersIgnoringModifiers) ||
                         ObjC.unwrap(ev.characters) || '';
                if (ch === String.fromCharCode(27)) { quit('escape'); return; }
                if (ch === '1') act(STILL);
                else if (ch === '2') act(GOT);
                else if (ch === ' ') act(SHOW);
                else if (ch === 'x' || ch === 'X') act(REMOVE);
            }
        }
    }
});

// An option row you can hit on the first click even when the drill is not the
// active app. By default macOS spends that click activating the app and the
// button never sees it, which reads exactly like a dead window.
ObjC.registerSubclass({
    name: 'DrillHit',
    superclass: 'NSButton',
    methods: {
        'acceptsFirstMouse:': {
            types: ['bool', ['id']],
            implementation: function () { return true; }
        }
    }
});

// The card face. It must never become first responder: if clicking the text
// took the keyboard, space / 1 / 2 would stop working for the rest of the
// session. Scrolling with the trackpad does not need it.
ObjC.registerSubclass({
    name: 'DrillWeb',
    superclass: 'WKWebView',
    methods: {
        'acceptsFirstResponder': {
            types: ['bool', []],
            implementation: function () { return false; }
        },
        'acceptsFirstMouse:': {
            types: ['bool', ['id']],
            implementation: function () { return true; }
        }
    }
});

ObjC.registerSubclass({
    name: 'DrillAgent',
    superclass: 'NSObject',
    methods: {
        'pick:': {
            types: ['void', ['id']],
            implementation: function (sender) { act(sender.tag); }
        },
        'quitNow:': {
            types: ['void', ['id']],
            implementation: function () { $.NSApp.terminate($()); }
        },
        'settle:': {
            types: ['void', ['id']],
            implementation: function () { settle(); }
        },
        'grabFocus:': {
            types: ['void', ['id']],
            implementation: function () { grabFocus(); }
        },
        'windowWillClose:': {
            types: ['void', ['id']],
            implementation: function () { quit('window-closed'); }
        },
        'keepalive:': {
            types: ['void', ['id']],
            implementation: function () { }
        }
    }
});

// -------------------------------------------------------------------- state

var STARTED = false;
var win, root, kicker, footer, agent, app, web;
var closing = null;     // the "Done" line, built when the session ends
var btns = {};          // SHOW / STILL / GOT -> {views: [...], sub}
var cards = [], PAYLOAD = null, SESSION = '';
var i = 0, right = 0, wrong = 0, removedN = 0;
var revealed = false, finished = false;
var dues = [];          // epoch seconds produced by this session's answers

// The card page takes its card from the URL fragment (see card.html for why
// there is no evaluateJavaScript here). Changing only the fragment is a
// same-document navigation, so flipping a card does not reload the page.
function showCard(withBack) {
    var c = cards[i];
    var frag = encodeURIComponent(JSON.stringify(
        { front: c.front, back: c.back, show: withBack }));
    var base = $.NSURL.fileURLWithPath(DIR + '/webapp/card.html').absoluteString;
    web.loadFileURLAllowingReadAccessToURL(
        $.NSURL.URLWithString(ObjC.unwrap(base) + '#' + frag),
        $.NSURL.fileURLWithPath(DIR + '/webapp'));
}

// A native button: a box, two labels, and a transparent NSButton over the lot
// (see DrillHit). The box cannot take the click itself -- a plain view never
// receives mouseDown through the NSTextFields on top of it.
function makeButton(tag, rect, title, color, border) {
    var views = [];
    var box = $.NSBox.alloc.initWithFrame(rect);
    box.boxType = BOX_CUSTOM;
    box.titlePosition = NO_TITLE;
    box.fillColor = ROW;
    box.borderColor = border;
    box.borderWidth = 1;
    box.cornerRadius = 10;
    root.addSubview(box);
    views.push(box);

    var t = label(title,
        $.NSMakeRect(rect.origin.x, rect.origin.y + 24, rect.size.width, 22),
        F_BTN, color, CENTER, false);
    root.addSubview(t);
    views.push(t);

    var sub = label('',
        $.NSMakeRect(rect.origin.x, rect.origin.y + 8, rect.size.width, 16),
        F_SUB, MUTED, CENTER, false);
    root.addSubview(sub);
    views.push(sub);

    // It must refuse first responder, or clicking would take the keyboard off
    // the root view and the keys would stop working for the rest of the session.
    var hit = $.DrillHit.alloc.initWithFrame(rect);
    hit.title = '';
    hit.bordered = false;
    hit.transparent = true;
    hit.focusRingType = 1;          // NSFocusRingTypeNone
    hit.refusesFirstResponder = true;
    hit.tag = tag;
    hit.target = agent;
    hit.action = 'pick:';
    root.addSubview(hit);
    views.push(hit);

    btns[tag] = { views: views, sub: sub };
}

function setHidden(tag, hide) {
    var v = btns[tag].views;
    for (var k = 0; k < v.length; k++) v[k].hidden = hide;
}

function humanDelta(epoch) {
    var secs = epoch - (new Date().getTime() / 1000);
    if (secs < 90) return 'in a moment';
    var mins = secs / 60;
    if (mins < 60) return 'in ' + Math.round(mins) + ' min';
    var hours = mins / 60;
    if (hours < 24) return 'in ' + Math.round(hours) + 'h';
    return 'in ' + Math.round(hours / 24) + 'd';
}

function footText(extra) {
    var foot = (i + 1) + ' of ' + cards.length + '   ·   ' + extra;
    if (PAYLOAD.crankEndsAt) {
        var left = Math.max(0, Math.ceil((PAYLOAD.crankEndsAt - Date.now() / 1000) / 60));
        foot += '   ·   ' + left + ' min left';
    }
    return foot;
}

function show() {
    if (i >= cards.length) { showDone(); return; }
    var c = cards[i];
    revealed = false;

    kicker.stringValue = (c.cat || '').toUpperCase();
    showCard(false);

    setHidden(SHOW, false);
    setHidden(STILL, true);
    setHidden(GOT, true);
    footer.stringValue = footText('space to turn it over');
}

function reveal() {
    revealed = true;
    var c = cards[i];
    showCard(true);
    btns[STILL].sub.stringValue = 'again ' + humanDelta(c.dueIfWrong);
    btns[GOT].sub.stringValue = 'next ' + humanDelta(c.dueIfRight);
    setHidden(SHOW, true);
    setHidden(STILL, false);
    setHidden(GOT, false);
    footer.stringValue = footText('1 still learning   ·   2 got it');
}

// Everything the window can be asked to do, from a click or a key.
act = function (what) {
    what = parseInt(what, 10);      // an NSButton's tag arrives as a string
    if (isNaN(what) || finished) return;

    if (what === SHOW) { if (!revealed) reveal(); return; }

    // "This card isn't useful to me": never shown again, and not graded --
    // it says nothing about whether you know it. Allowed before or after the
    // answer is turned over. drill.py records it in removed.json.
    if (what === REMOVE) {
        emit({ t: 'remove', id: cards[i].id });
        removedN++;
        i++;
        show();
        return;
    }

    // Grading is only possible once the answer has been seen. This is the
    // whole point of the flow: a key pressed too early must not count.
    if (!revealed) return;
    var c = cards[i];
    var got = (what === GOT);
    revealed = false;

    if (got) { right++; dues.push(c.dueIfRight); }
    else { wrong++; dues.push(c.dueIfWrong); }

    // Tell drill.py straight away, so a crash or a force-quit costs at most
    // the card currently on screen. `correct` means "got it".
    emit({ t: 'answer', id: c.id, correct: got });

    i++;
    show();
};

settle = function () { win.level = $.NSNormalWindowLevel; };

grabFocus = function () {
    $.NSRunningApplication.currentApplication.activateWithOptions(
        $.NSApplicationActivateIgnoringOtherApps);
    app.activateIgnoringOtherApps(true);
    win.makeKeyAndOrderFront($());
    win.makeFirstResponder(root);
};

function showDone() {
    setHidden(SHOW, true);
    setHidden(STILL, true);
    setHidden(GOT, true);
    web.hidden = true;
    kicker.stringValue = '';

    var text = 'Done — ' + right + '/' + (right + wrong) + ' got it' +
        (removedN ? '   ·   ' + removedN + ' removed' : '');
    closing = label(text, $.NSMakeRect(40, PROMPT_MID - 20, W - 80, 40),
        F_PROMPT, FG, CENTER, true);
    root.addSubview(closing);

    if (PAYLOAD.crankEndsAt && Date.now() / 1000 < PAYLOAD.crankEndsAt - 20) {
        footer.stringValue = 'Next round in a moment…';
    } else if (PAYLOAD.remaining > 0) {
        footer.stringValue = PAYLOAD.remaining + ' more still due.';
    } else {
        var all = dues.slice();
        if (PAYLOAD.baselineNextDue) all.push(PAYLOAD.baselineNextDue);
        all.sort(function (a, b) { return a - b; });
        footer.stringValue = all.length
            ? 'Next card ' + humanDelta(all[0]) + '.' : '';
    }

    finished = true;
    emit({ t: 'done', right: right, wrong: wrong, reason: 'finished', card: i });
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
        2.2, agent, 'quitNow:', $(), false);
}

quit = function (reason) {
    if (!finished) {
        finished = true;
        emit({ t: 'done', right: right, wrong: wrong,
               reason: reason || 'unknown', card: i });
    }
    $.NSApp.terminate($());
};

// ------------------------------------------------------------------- launch

function start() {
    if (STARTED) return;            // the applet host also calls run()
    STARTED = true;

    PAYLOAD = readJSON(PAYLOAD_PATH);
    if (!PAYLOAD || !PAYLOAD.cards || !PAYLOAD.cards.length) {
        emit({ t: 'error', msg: 'no payload at ' + PAYLOAD_PATH });
        $.NSApplication.sharedApplication.terminate($());
        return;
    }
    cards = PAYLOAD.cards;
    SESSION = PAYLOAD.session || '';

    app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
    agent = $.DrillAgent.alloc.init;
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
        600, agent, 'keepalive:', $(), true);

    win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(0, 0, W, H),
        $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
        $.NSBackingStoreBuffered, false);
    win.title = 'Learnmax';
    win.backgroundColor = BG;
    win.releasedWhenClosed = false;

    root = $.DrillRoot.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    win.contentView = root;
    win.delegate = agent;

    // Opaque backdrop: the window's own background does not show up in a
    // cacheDisplayInRect: snapshot, and this keeps both paths identical.
    var backdrop = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    backdrop.boxType = BOX_CUSTOM;
    backdrop.titlePosition = NO_TITLE;
    backdrop.borderWidth = 0;
    backdrop.cornerRadius = 0;
    backdrop.fillColor = BG;
    root.addSubview(backdrop);

    kicker = label('', $.NSMakeRect(PAD, H - 46, W - PAD * 2, 18),
        F_KICKER, MUTED, CENTER, false);
    root.addSubview(kicker);

    footer = label('', $.NSMakeRect(30, FOOT_Y, W - 60, 18),
        F_FOOT, MUTED, CENTER, false);
    root.addSubview(footer);

    var bw = (W - PAD * 2 - BTN_GAP) / 2;
    makeButton(SHOW, $.NSMakeRect(PAD, BTN_Y, W - PAD * 2, BTN_H),
               'Show answer', FG, LINE);
    btns[SHOW].sub.stringValue = 'space';
    makeButton(STILL, $.NSMakeRect(PAD, BTN_Y, bw, BTN_H),
               'Still learning', RED, RED);
    makeButton(GOT, $.NSMakeRect(PAD + bw + BTN_GAP, BTN_Y, bw, BTN_H),
               'Got it', GREEN, GREEN);

    // A quiet text link under the buttons: removing a card should be easy to
    // do and hard to do by accident, so it is small and away from the grades.
    var rmRect = $.NSMakeRect(W / 2 - 110, 12, 220, 22);
    var rmLabel = label('Remove this card  ·  x', rmRect, F_SUB, MUTED, CENTER, false);
    root.addSubview(rmLabel);
    var rmHit = $.DrillHit.alloc.initWithFrame(rmRect);
    rmHit.title = '';
    rmHit.bordered = false;
    rmHit.transparent = true;
    rmHit.focusRingType = 1;
    rmHit.refusesFirstResponder = true;
    rmHit.tag = REMOVE;
    rmHit.target = agent;
    rmHit.action = 'pick:';
    root.addSubview(rmHit);

    // The card face. Pointed at the page by file URL with read access to the
    // webapp directory, which is where KaTeX and its fonts live.
    var conf = $.WKWebViewConfiguration.alloc.init;
    web = $.DrillWeb.alloc.initWithFrameConfiguration(
        $.NSMakeRect(0, WEB_Y, W, H - WEB_Y - WEB_TOP), conf);
    root.addSubview(web);

    show();

    if (SNAPSHOT) {
        // Draw the native parts to PNG and leave. The web view does not
        // appear in a cacheDisplayInRect: snapshot, so this checks layout
        // and buttons only.
        var pick = env('DRILL_SNAPSHOT_PICK');
        var snap = function (path) {
            root.displayIfNeeded;
            var rep = root.bitmapImageRepForCachingDisplayInRect(root.bounds);
            root.cacheDisplayInRectToBitmapImageRep(root.bounds, rep);
            rep.representationUsingTypeProperties(
                $.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary)
                .writeToFileAtomically(path, true);
        };
        snap(SNAPSHOT);
        if (pick !== null) {
            act(SHOW);
            snap(SNAPSHOT.replace(/\.png$/, '-revealed.png'));
        }
        $.NSApp.terminate($());
        return;
    }

    win.center;
    win.level = $.NSFloatingWindowLevel;
    grabFocus();

    // Re-assert focus once the run loop is turning. A single call before the
    // loop starts gets dropped when the app was launched in the background.
    [0.05, 0.3, 0.8].forEach(function (t) {
        $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
            t, agent, 'grabFocus:', $(), false);
    });

    // Stop floating above everything once it has surfaced, so it can be
    // pushed aside like any other window.
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
        1.5, agent, 'settle:', $(), false);
}

// The compiled applet calls run(); running the file directly under osascript
// falls through to the call at the bottom. start() guards against doing both.
function run() { start(); }

// Keeps a stay-open applet alive between events without burning CPU.
function idle() { return 3600; }

start();
if (!/\.app$/.test(ObjC.unwrap($.NSBundle.mainBundle.bundlePath) || '')) {
    // Standalone: we own the run loop. The applet host owns its own.
    $.NSApplication.sharedApplication.run;
}
