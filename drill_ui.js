// Levantine Arabic drill -- the window.
//
// This file is the source for ArabicDrill.app, which drill.py compiles with
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
// drill.py owns all the scheduling. This file owns pixels and keystrokes, and
// appends one JSON line per answer to the results file as it goes, so grading
// is persisted while the session runs rather than only at the end.

ObjC.import('Cocoa');

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

var W = 640, H = 460;
var PAD = 60, ROW_W = W - PAD * 2, ROW_H = 46, ROW_GAP = 10;
var ROW_TOP = 292;                    // top edge of the first option row
var PROMPT_MID = 356;                 // prompt block is centred on this line

var F_KICKER = $.NSFont.systemFontOfSizeWeight(11, $.NSFontWeightSemibold);
var F_PROMPT = $.NSFont.systemFontOfSizeWeight(28, $.NSFontWeightMedium);
var F_LETTER = $.NSFont.systemFontOfSizeWeight(13, $.NSFontWeightSemibold);
var F_OPT = $.NSFont.systemFontOfSizeWeight(15, $.NSFontWeightRegular);
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

function textHeight(text, font, width) {
    try {
        var attrs = $.NSDictionary.dictionaryWithObjectForKey(
            font, $.NSFontAttributeName);
        var r = $.NSString.alloc.initWithUTF8String(text)
            .boundingRectWithSizeOptionsAttributes(
                $.NSMakeSize(width, 400), 1 /* UsesLineFragmentOrigin */, attrs);
        return Math.ceil(r.size.height) + 8;
    } catch (e) {
        var perLine = Math.max(1, Math.floor(width / (font.pointSize * 0.52)));
        return Math.ceil(text.length / perLine) * (font.pointSize * 1.3) + 8;
    }
}

// --------------------------------------------------------------- subclasses

// Forward declarations, so the ObjC method bodies can reach them.
var choose = function () {};
var quit = function () {};
var advance = function () {};
var settle = function () {};
var grabFocus = function () {};

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
                var byCode = { 18: 0, 19: 1, 20: 2, 21: 3,        // number row
                               83: 0, 84: 1, 85: 2, 86: 3 };      // keypad
                if (byCode[code] !== undefined) { choose(byCode[code]); return; }
                var ch = ObjC.unwrap(ev.charactersIgnoringModifiers) ||
                         ObjC.unwrap(ev.characters) || '';
                if (ch === String.fromCharCode(27)) { quit('escape'); return; }
                if (ch !== '' && '1234'.indexOf(ch) >= 0) choose(parseInt(ch, 10) - 1);
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

ObjC.registerSubclass({
    name: 'DrillAgent',
    superclass: 'NSObject',
    methods: {
        'advance:': {
            types: ['void', ['id']],
            implementation: function () { advance(); }
        },
        'pick:': {
            types: ['void', ['id']],
            implementation: function (sender) { choose(sender.tag); }
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
var win, root, kicker, footer, agent, app;
var prompt = null;      // rebuilt per card, because its height varies
var rows = [];          // {box, hit, letter, text, value}
var cards = [], PAYLOAD = null, SESSION = '';
var i = 0, right = 0, wrong = 0;
var locked = false, finished = false;
var dues = [];          // epoch seconds produced by this session's answers

function clearCard() {
    if (prompt) { prompt.removeFromSuperview; prompt = null; }
    for (var k = 0; k < rows.length; k++) {
        rows[k].box.removeFromSuperview;
        rows[k].hit.removeFromSuperview;
    }
    rows = [];
}

function buildRow(idx, text) {
    var y = ROW_TOP - ROW_H - idx * (ROW_H + ROW_GAP);
    var box = $.NSBox.alloc.initWithFrame($.NSMakeRect(PAD, y, ROW_W, ROW_H));
    box.boxType = BOX_CUSTOM;
    box.titlePosition = NO_TITLE;
    box.fillColor = ROW;
    box.borderColor = LINE;
    box.borderWidth = 1;
    box.cornerRadius = 8;

    // NSBox insets its content view, so place children relative to that.
    var letter = label(String.fromCharCode(65 + idx),
        $.NSMakeRect(18, 14, 22, 20), F_LETTER, MUTED, LEFT, false);
    var body = label(text,
        $.NSMakeRect(46, 14, ROW_W - 66, 20), F_OPT, FG, LEFT, false);
    box.contentView.addSubview(letter);
    box.contentView.addSubview(body);
    root.addSubview(box);

    // A transparent NSButton over the whole row does the clicking. The box
    // cannot: a plain view's mouseDown never arrives, because the NSTextField
    // on top of it eats the event first. A transparent button still tracks the
    // mouse, it just does not draw. It must refuse first responder, or
    // clicking would take the keyboard off the root view and 1-4 would stop
    // working for the rest of the session.
    var hit = $.DrillHit.alloc.initWithFrame($.NSMakeRect(PAD, y, ROW_W, ROW_H));
    hit.title = '';
    hit.bordered = false;
    hit.transparent = true;
    hit.focusRingType = 1;          // NSFocusRingTypeNone
    hit.refusesFirstResponder = true;
    hit.tag = idx;
    hit.target = agent;
    hit.action = 'pick:';
    root.addSubview(hit);

    rows.push({ box: box, hit: hit, letter: letter, text: body, value: text });
}

function show() {
    clearCard();
    if (i >= cards.length) { showDone(); return; }
    var c = cards[i];

    kicker.stringValue = c.kicker;

    var h = textHeight(c.prompt, F_PROMPT, W - 80);
    prompt = label(c.prompt,
        $.NSMakeRect(40, Math.round(PROMPT_MID - h / 2), W - 80, h),
        F_PROMPT, FG, CENTER, true);
    root.addSubview(prompt);

    for (var k = 0; k < c.options.length; k++) buildRow(k, c.options[k]);

    var foot = (i + 1) + ' of ' + cards.length + '   ·   press 1–4';
    if (PAYLOAD.crankEndsAt) {
        var left = Math.max(0, Math.ceil((PAYLOAD.crankEndsAt - Date.now() / 1000) / 60));
        foot += '   ·   ' + left + ' min left';
    }
    footer.stringValue = foot;
    locked = false;
}

choose = function (idx) {
    // The bridge hands back an NSButton's tag as a string, so a strict
    // comparison against the loop counter below would never match and the
    // chosen row would never turn red -- every answer looked correct.
    idx = parseInt(idx, 10);
    if (isNaN(idx) || locked || finished || idx < 0 || idx >= rows.length) return;
    locked = true;

    var c = cards[i];
    var correct = rows[idx].value === c.answer;

    for (var k = 0; k < rows.length; k++) {
        var r = rows[k];
        if (r.value === c.answer) {
            r.box.borderColor = GREEN;
            r.text.textColor = GREEN;
            r.letter.textColor = GREEN;
        } else if (k === idx) {
            r.box.borderColor = RED;
            r.text.textColor = RED;
            r.letter.textColor = RED;
        }
    }

    if (correct) {
        right++;
        dues.push(c.dueIfRight);
        footer.stringValue = 'Correct';
    } else {
        wrong++;
        dues.push(c.dueIfWrong);
        footer.stringValue = c.answer + (c.hint ? '  —  ' + c.hint : '');
    }

    // Tell drill.py straight away, so a crash or a force-quit costs at most
    // the card currently on screen.
    emit({ t: 'answer', id: c.id, correct: correct });

    i++;
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
        correct ? 1.1 : 2.1, agent, 'advance:', $(), false);
};

advance = function () { if (!finished) show(); };

settle = function () { win.level = $.NSNormalWindowLevel; };

grabFocus = function () {
    $.NSRunningApplication.currentApplication.activateWithOptions(
        $.NSApplicationActivateIgnoringOtherApps);
    app.activateIgnoringOtherApps(true);
    win.makeKeyAndOrderFront($());
    win.makeFirstResponder(root);
};

function humanDelta(epoch) {
    var secs = epoch - (new Date().getTime() / 1000);
    if (secs < 90) return 'in a moment';
    var mins = secs / 60;
    if (mins < 60) return 'in ' + Math.round(mins) + ' min';
    var hours = mins / 60;
    if (hours < 24) return 'in ' + Math.round(hours) + 'h';
    return 'in ' + Math.round(hours / 24) + 'd';
}

function showDone() {
    clearCard();
    kicker.stringValue = '';
    var text = 'Done — ' + right + '/' + (right + wrong) + ' right';
    var h = textHeight(text, F_PROMPT, W - 80);
    prompt = label(text,
        $.NSMakeRect(40, Math.round(PROMPT_MID - h / 2), W - 80, h),
        F_PROMPT, FG, CENTER, true);
    root.addSubview(prompt);

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
    win.title = 'Arabic';
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

    kicker = label('', $.NSMakeRect(PAD, 412, ROW_W, 18),
        F_KICKER, MUTED, CENTER, false);
    root.addSubview(kicker);

    footer = label('', $.NSMakeRect(30, 26, W - 60, 34),
        F_FOOT, MUTED, CENTER, true);
    root.addSubview(footer);

    show();

    if (SNAPSHOT) {
        // Draw frames to PNG and leave, so the layout can be checked without
        // screen-recording permission.
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
            choose(parseInt(pick, 10));
            snap(SNAPSHOT.replace(/\.png$/, '-graded.png'));
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
