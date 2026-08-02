// Levantine Arabic -- home screen and analytics.
//
// Source for ArabicHome.app, compiled by home.py with osacompile and launched
// with `open`. Same constraints as drill_ui.js, for the same reasons:
//   * no CALayer -- setting a CGColorRef through the JXA bridge crashes with
//     EXC_ARM_PAC_FAIL, so fills and borders are NSBox
//   * clickable rows are a transparent NSButton laid over the box, because a
//     plain view never receives mouseDown through an NSTextField
//   * an NSButton's tag comes back as a string, so every tag is parseInt'd
//   * NSTextAlignment on modern macOS is UIKit-ordered: left 0, centre 1
//
// It reads a stats payload written by home.py and writes back one command
// line, then quits. home.py acts on the command and reopens this. Keeping the
// two processes in a loop like that means the drill session and the home
// screen are never on screen fighting each other.

ObjC.import('Cocoa');

// ---------------------------------------------------------------- plumbing

function env(name) {
    var v = $.NSProcessInfo.processInfo.environment.objectForKey(name);
    return v.isNil() ? null : ObjC.unwrap(v);
}

function baseDir() {
    var bp = ObjC.unwrap($.NSBundle.mainBundle.bundlePath) || '';
    if (/\.app$/.test(bp)) return bp.replace(/\/[^\/]+\.app$/, '');
    var args = ObjC.unwrap($.NSProcessInfo.processInfo.arguments)
        .map(function (a) { return ObjC.unwrap(a); });
    for (var i = 0; i < args.length; i++) {
        if (/home_ui\.js$/.test(args[i])) {
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
var PAYLOAD_PATH = env('HOME_PAYLOAD') || (DIR + '/.home-payload.json');
var RESULTS_PATH = env('HOME_RESULTS') || (DIR + '/.home-results.jsonl');
var SNAPSHOT = env('HOME_SNAPSHOT');
var SNAPSHOT_VIEW = env('HOME_SNAPSHOT_VIEW') || 'home';

var SESSION = '';

function emit(obj) {
    obj.s = SESSION;            // ignore lines from a window still closing
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
    var s = $.NSString.stringWithContentsOfFileEncodingError(
        path, $.NSUTF8StringEncoding, $());
    if (s.isNil()) return null;
    try { return JSON.parse(ObjC.unwrap(s)); } catch (e) { return null; }
}

// ------------------------------------------------------------------- style

function rgb(r, g, b) {
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(r / 255, g / 255, b / 255, 1.0);
}
var BG = rgb(28, 28, 30);
var PANEL = rgb(38, 38, 41);
var PANEL2 = rgb(44, 44, 48);
var FG = rgb(242, 242, 247);
var MUTED = rgb(142, 142, 147);
var DIM = rgb(99, 99, 104);
var LINE = rgb(58, 58, 60);
var GREEN = rgb(48, 209, 88);
var BLUE = rgb(10, 132, 255);
var AMBER = rgb(255, 159, 10);
var RED = rgb(255, 69, 58);

var LEFT = 0, CENTER = 1, RIGHT = 2;
var BOX_CUSTOM = 4, NO_TITLE = 0;

var W = 760;
var H = 656;                 // current content height; analytics is taller
var H_HOME = 656, H_STATS = 940;
var M = 48;                  // page margin
var CW = W - M * 2;          // content width

function font(size, weight) {
    return $.NSFont.systemFontOfSizeWeight(size, weight);
}
var WT_REG = $.NSFontWeightRegular,
    WT_MED = $.NSFontWeightMedium,
    WT_SEMI = $.NSFontWeightSemibold,
    WT_BOLD = $.NSFontWeightBold;

// y for something `top` points below the top edge, given its height
function T(top, height) { return H - top - height; }

// ----------------------------------------------------------------- widgets

function label(text, frame, f, color, align, wrap) {
    var t = $.NSTextField.alloc.initWithFrame(frame);
    t.bezeled = false;
    t.drawsBackground = false;
    t.editable = false;
    t.selectable = false;
    t.font = f;
    t.textColor = color;
    t.alignment = align;
    if (wrap) {
        t.usesSingleLineMode = false;
        t.cell.wraps = true;
        t.cell.lineBreakMode = 0;
    }
    t.stringValue = text;
    return t;
}

function panel(frame, fill, border, radius) {
    var b = $.NSBox.alloc.initWithFrame(frame);
    b.boxType = BOX_CUSTOM;
    b.titlePosition = NO_TITLE;
    b.fillColor = fill;
    b.borderColor = border || fill;
    b.borderWidth = border ? 1 : 0;
    b.cornerRadius = (radius === undefined) ? 10 : radius;
    return b;
}

ObjC.registerSubclass({
    name: 'HomeHit',
    superclass: 'NSButton',
    methods: {
        'acceptsFirstMouse:': {
            types: ['bool', ['id']],
            implementation: function () { return true; }
        }
    }
});

var onCommand = function () {};

ObjC.registerSubclass({
    name: 'HomeAgent',
    superclass: 'NSObject',
    methods: {
        'hit:': {
            types: ['void', ['id']],
            implementation: function (sender) {
                onCommand(parseInt(sender.tag, 10));
            }
        },
        'grabFocus:': {
            types: ['void', ['id']],
            implementation: function () { grabFocus(); }
        },
        'keepalive:': { types: ['void', ['id']], implementation: function () { } },
        'windowWillClose:': {
            types: ['void', ['id']],
            implementation: function () {
                emit({ t: 'cmd', cmd: 'quit' });
                $.NSApp.terminate($());
            }
        }
    }
});

// ------------------------------------------------------------------- state

var STARTED = false;
var app, win, root, backdrop, agent;
var S = null;                // the stats payload
var views = [];              // everything belonging to the current view
var actions = [];            // tag -> {cmd, mode}
var view = 'home';

function add(v) { root.addSubview(v); views.push(v); return v; }

function clearView() {
    for (var i = 0; i < views.length; i++) views[i].removeFromSuperview;
    views = [];
    actions = [];
}

// A clickable region: box + label(s) + transparent button on top.
function button(rect, title, subtitle, action, opts) {
    opts = opts || {};
    var fill = opts.fill || PANEL;
    var accent = opts.accent || null;
    add(panel(rect, fill, accent || LINE, opts.radius));

    var hasSub = subtitle !== null && subtitle !== undefined && subtitle !== '';
    var titleY = hasSub ? rect.size.height / 2 - 2 : rect.size.height / 2 - 11;
    add(label(title,
        $.NSMakeRect(rect.origin.x, rect.origin.y + titleY, rect.size.width, 22),
        font(opts.size || 15, opts.weight || WT_MED),
        opts.color || FG, CENTER, false));
    if (hasSub) {
        add(label(subtitle,
            $.NSMakeRect(rect.origin.x, rect.origin.y + rect.size.height / 2 - 22,
                         rect.size.width, 18),
            font(12, WT_REG), opts.subColor || MUTED, CENTER, false));
    }

    var hit = $.HomeHit.alloc.initWithFrame(rect);
    hit.title = '';
    hit.bordered = false;
    hit.transparent = true;
    hit.focusRingType = 1;
    hit.refusesFirstResponder = true;
    hit.tag = actions.length;
    hit.target = agent;
    hit.action = 'hit:';
    actions.push(action);
    add(hit);
    return hit;
}

function tile(rect, value, caption, color) {
    add(panel(rect, PANEL, LINE));
    add(label(value,
        $.NSMakeRect(rect.origin.x, rect.origin.y + rect.size.height - 46,
                     rect.size.width, 32),
        font(26, WT_SEMI), color || FG, CENTER, false));
    add(label(caption,
        $.NSMakeRect(rect.origin.x, rect.origin.y + 12, rect.size.width, 16),
        font(11, WT_MED), MUTED, CENTER, false));
}

function progressBar(x, y, w, h, frac, color) {
    add(panel($.NSMakeRect(x, y, w, h), PANEL2, null, h / 2));
    var fw = Math.max(h, Math.round(w * Math.max(0, Math.min(1, frac))));
    if (frac > 0) add(panel($.NSMakeRect(x, y, fw, h), color || GREEN, null, h / 2));
}

function sectionLabel(text, top) {
    add(label(text, $.NSMakeRect(M, T(top, 14), CW, 14),
        font(11, WT_SEMI), DIM, LEFT, false));
}

// -------------------------------------------------------------------- home

function buildHome() {
    var pct = S.total ? S.seen / S.total : 0;

    add(label('LEVANTINE ARABIC', $.NSMakeRect(M, T(40, 16), CW, 16),
        font(11, WT_SEMI), DIM, CENTER, false));

    var headline = S.dueNow > 0
        ? S.dueNow + (S.dueNow === 1 ? ' card due' : ' cards due')
        : 'All caught up';
    add(label(headline, $.NSMakeRect(M, T(78, 44), CW, 44),
        font(34, WT_SEMI), S.dueNow > 0 ? FG : GREEN, CENTER, false));

    var sub = S.nextDueHuman && S.dueNow === 0
        ? 'Next card ' + S.nextDueHuman
        : S.seen + ' of ' + S.total + ' cards started';
    add(label(sub, $.NSMakeRect(M, T(124, 20), CW, 20),
        font(13, WT_REG), MUTED, CENTER, false));

    progressBar(M, T(166, 10), CW, 10, pct, GREEN);
    add(label(Math.round(pct * 100) + '% of the deck seen  ·  '
              + S.graduated + ' past the first day',
        $.NSMakeRect(M, T(192, 16), CW, 16), font(11, WT_REG), DIM, CENTER, false));

    // Four figures across
    var tw = (CW - 3 * 12) / 4;
    var ty = T(236, 82);
    tile($.NSMakeRect(M + 0 * (tw + 12), ty, tw, 82),
         String(S.dueNow), 'DUE NOW', S.dueNow ? AMBER : GREEN);
    tile($.NSMakeRect(M + 1 * (tw + 12), ty, tw, 82),
         String(S.todayDone), 'DONE TODAY', BLUE);
    tile($.NSMakeRect(M + 2 * (tw + 12), ty, tw, 82),
         S.todayAccuracy === null ? '—' : S.todayAccuracy + '%', 'TODAY RIGHT',
         S.todayAccuracy === null ? MUTED
             : (S.todayAccuracy >= 80 ? GREEN : (S.todayAccuracy >= 60 ? AMBER : RED)));
    tile($.NSMakeRect(M + 3 * (tw + 12), ty, tw, 82),
         String(S.streak), S.streak === 1 ? 'DAY STREAK' : 'DAY STREAK', FG);

    // Primary actions: one round, or keep the rounds coming for half an hour.
    var startN = Math.min(S.dueNow, S.sessionCap);
    var mainW = Math.round(CW * 0.55);
    button($.NSMakeRect(M, T(340, 56), mainW, 56),
        S.dueNow > 0 ? 'Start session' : 'Practice anyway',
        S.dueNow > 0
            ? startN + (startN === 1 ? ' card' : ' cards') + ' waiting'
            : 'Nothing is due — review ' + Math.min(S.sessionCap, S.total) + ' anyway',
        { cmd: 'start', mode: S.dueNow > 0 ? 'due' : 'all' },
        { fill: PANEL2, accent: GREEN, size: 16, weight: WT_SEMI, color: GREEN });
    button($.NSMakeRect(M + mainW + 10, T(340, 56), CW - mainW - 10, 56),
        '30-minute session',
        'rounds keep coming until time is up',
        { cmd: 'start', mode: 'timed30' },
        { fill: PANEL2, accent: BLUE, size: 15, weight: WT_SEMI, color: BLUE });

    sectionLabel('OR CUE SOMETHING SPECIFIC', 418);

    var bw = (CW - 3 * 10) / 4;
    var by = T(440, 46);
    var quick = [
        ['Vocab', S.byCat.vocab ? S.byCat.vocab.total : 0, 'vocab'],
        ['Sentences', S.byCat.sentences ? S.byCat.sentences.total : 0, 'sentences'],
        ['Arabic → English', S.dirCounts.ar2en, 'ar2en'],
        ['English → Arabic', S.dirCounts.en2ar, 'en2ar']
    ];
    quick.forEach(function (q, i) {
        button($.NSMakeRect(M + i * (bw + 10), by, bw, 46),
            q[0], q[1] + ' cards', { cmd: 'start', mode: q[2] },
            { size: 13 });
    });

    var hw = (CW - 20) / 3;
    var hy = T(496, 46);
    button($.NSMakeRect(M, hy, hw, 46),
        'Trouble cards',
        S.lapsedCount ? S.lapsedCount + ' have tripped you up' : 'none yet',
        { cmd: 'start', mode: 'hardest' },
        { size: 13, color: S.lapsedCount ? FG : DIM });
    button($.NSMakeRect(M + hw + 10, hy, hw, 46),
        'New cards', S.newLeft + ' never seen',
        { cmd: 'start', mode: 'new' }, { size: 13 });
    // Whatever was added to cards.json most recently -- "the new material".
    button($.NSMakeRect(M + (hw + 10) * 2, hy, hw, 46),
        'Latest batch',
        S.latestTotal
            ? (S.latestTotal - S.latestSeen) + ' of ' + S.latestTotal + ' still new'
            : 'nothing tagged',
        { cmd: 'start', mode: 'lesson' },
        { size: 13, color: S.latestTotal ? FG : DIM });

    button($.NSMakeRect(M, T(566, 44), CW, 44),
        'Analytics', null, { cmd: 'view', view: 'stats' }, { size: 14 });
}

// --------------------------------------------------------------- analytics

function buildStats() {
    add(label('ANALYTICS', $.NSMakeRect(M, T(40, 16), CW, 16),
        font(11, WT_SEMI), DIM, CENTER, false));
    add(label('How it is going', $.NSMakeRect(M, T(76, 40), CW, 40),
        font(30, WT_SEMI), FG, CENTER, false));

    var tw = (CW - 3 * 12) / 4;
    var ty = T(150, 82);
    tile($.NSMakeRect(M + 0 * (tw + 12), ty, tw, 82),
         String(S.totalReviews), 'REVIEWS ALL TIME', FG);
    tile($.NSMakeRect(M + 1 * (tw + 12), ty, tw, 82),
         S.overallAccuracy === null ? '—' : S.overallAccuracy + '%', 'ACCURACY',
         S.overallAccuracy === null ? MUTED
             : (S.overallAccuracy >= 80 ? GREEN : (S.overallAccuracy >= 60 ? AMBER : RED)));
    tile($.NSMakeRect(M + 2 * (tw + 12), ty, tw, 82),
         String(S.graduated), 'PAST DAY ONE', BLUE);
    tile($.NSMakeRect(M + 3 * (tw + 12), ty, tw, 82),
         S.avgEase === null ? '—' : String(S.avgEase), 'AVG EASE', FG);

    // Fourteen-day activity
    sectionLabel('LAST 14 DAYS', 254);
    var chartTop = 276, chartH = 118;
    var base = T(chartTop + chartH, 0);
    var peak = 1;
    S.history.forEach(function (d) { if (d.done > peak) peak = d.done; });
    var slot = CW / S.history.length;
    var barW = Math.floor(slot * 0.56);
    add(panel($.NSMakeRect(M, base - 1, CW, 1), LINE, null, 0));
    S.history.forEach(function (d, i) {
        var x = Math.round(M + i * slot + (slot - barW) / 2);
        var h = d.done ? Math.max(3, Math.round(chartH * d.done / peak)) : 0;
        if (h) {
            add(panel($.NSMakeRect(x, base, barW, h), PANEL2, null, 4));
            var rh = d.done ? Math.round(h * d.right / d.done) : 0;
            if (rh) add(panel($.NSMakeRect(x, base, barW, rh), GREEN, null, 4));
            add(label(String(d.done),
                $.NSMakeRect(x - 6, base + h + 4, barW + 12, 14),
                font(10, WT_MED), MUTED, CENTER, false));
        }
        add(label(d.label, $.NSMakeRect(x - 6, base - 20, barW + 12, 14),
            font(10, WT_REG), i === S.history.length - 1 ? FG : DIM, CENTER, false));
    });
    add(label('green = answered right',
        $.NSMakeRect(M, base - 38, CW, 14), font(10, WT_REG), DIM, CENTER, false));

    // Spread of the deck
    sectionLabel('WHERE THE DECK SITS', 470);
    var rowY = 492;
    var maxB = 1;
    S.buckets.forEach(function (b) { if (b.count > maxB) maxB = b.count; });
    var colors = { 'new': DIM, learning: AMBER, week: BLUE, month: GREEN, mature: GREEN };
    S.buckets.forEach(function (b, i) {
        var y = T(rowY + i * 24, 18);
        add(label(b.label, $.NSMakeRect(M, y, 150, 16),
            font(12, WT_REG), MUTED, LEFT, false));
        var trackX = M + 158, trackW = CW - 158 - 44;
        add(panel($.NSMakeRect(trackX, y + 4, trackW, 9), PANEL2, null, 4));
        if (b.count) {
            add(panel($.NSMakeRect(trackX, y + 4,
                Math.max(9, Math.round(trackW * b.count / maxB)), 9),
                colors[b.key] || BLUE, null, 4));
        }
        add(label(String(b.count), $.NSMakeRect(W - M - 40, y, 40, 16),
            font(12, WT_MED), FG, RIGHT, false));
    });

    // What is coming
    sectionLabel('COMING UP', 620);
    var uw = (CW - 3 * 10) / 4;
    S.upcoming.forEach(function (u, i) {
        var r = $.NSMakeRect(M + i * (uw + 10), T(642, 56), uw, 56);
        add(panel(r, PANEL, LINE));
        add(label(String(u.count),
            $.NSMakeRect(r.origin.x, r.origin.y + 26, r.size.width, 24),
            font(18, WT_SEMI), FG, CENTER, false));
        add(label(u.label.toUpperCase(),
            $.NSMakeRect(r.origin.x, r.origin.y + 9, r.size.width, 14),
            font(10, WT_MED), MUTED, CENTER, false));
    });

    sectionLabel(S.hardest.length ? 'GIVING YOU TROUBLE' : 'NOTHING GIVING YOU TROUBLE YET', 724);
    if (S.hardest.length) {
        S.hardest.slice(0, 5).forEach(function (h, i) {
            var y = T(748 + i * 26, 20);
            add(label(h.prompt, $.NSMakeRect(M, y, 250, 18),
                font(12, WT_MED), FG, LEFT, false));
            add(label(h.answer, $.NSMakeRect(M + 258, y, CW - 258 - 96, 18),
                font(12, WT_REG), MUTED, LEFT, false));
            add(label(h.lapses + (h.lapses === 1 ? ' slip' : ' slips'),
                $.NSMakeRect(W - M - 90, y, 90, 18),
                font(12, WT_MED), h.lapses > 2 ? RED : AMBER, RIGHT, false));
        });
    } else {
        add(label('Every card you have seen, you have got right so far.',
            $.NSMakeRect(M, T(750, 18), CW, 18), font(12, WT_REG), DIM, LEFT, false));
    }

    // Analytics is the landing page when opened from the Dock, so it needs a
    // way into a session rather than only a way back.
    var startW = Math.round(CW * 0.66), gap = 10;
    var startN = Math.min(S.dueNow, S.sessionCap);
    button($.NSMakeRect(M, T(884, 46), startW, 46),
        S.dueNow > 0 ? 'Start session  ·  ' + startN + ' cards' : 'Practice anyway',
        null, { cmd: 'start', mode: S.dueNow > 0 ? 'due' : 'all' },
        { fill: PANEL2, accent: GREEN, size: 15, weight: WT_SEMI, color: GREEN });
    button($.NSMakeRect(M + startW + gap, T(884, 46), CW - startW - gap, 46),
        'Home', null, { cmd: 'view', view: 'home' }, { size: 14 });
}

// -------------------------------------------------------------------- view

function setView(name) {
    view = name;
    var wanted = (name === 'stats') ? H_STATS : H_HOME;
    if (wanted !== H) {
        H = wanted;
        win.setContentSizeAnimate
            ? win.setContentSize($.NSMakeSize(W, H))
            : win.setContentSize($.NSMakeSize(W, H));
        root.frame = $.NSMakeRect(0, 0, W, H);
        backdrop.frame = $.NSMakeRect(0, 0, W, H);
    }
    clearView();
    if (name === 'stats') buildStats(); else buildHome();
    root.needsDisplay = true;
}

onCommand = function (tag) {
    var a = actions[tag];
    if (!a) return;
    if (a.cmd === 'view') { setView(a.view); return; }
    if (a.cmd === 'start') {
        emit({ t: 'cmd', cmd: 'start', mode: a.mode });
        $.NSApp.terminate($());
    }
};

var grabFocus = function () {
    $.NSRunningApplication.currentApplication.activateWithOptions(
        $.NSApplicationActivateIgnoringOtherApps);
    app.activateIgnoringOtherApps(true);
    win.makeKeyAndOrderFront($());
};

// ------------------------------------------------------------------ launch

function start() {
    if (STARTED) return;
    STARTED = true;

    S = readJSON(PAYLOAD_PATH);
    if (S) SESSION = S.session || '';
    if (!S) {
        emit({ t: 'cmd', cmd: 'quit', error: 'no payload at ' + PAYLOAD_PATH });
        $.NSApplication.sharedApplication.terminate($());
        return;
    }

    app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
    agent = $.HomeAgent.alloc.init;
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
        600, agent, 'keepalive:', $(), true);

    win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(0, 0, W, H),
        $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
        $.NSBackingStoreBuffered, false);
    win.title = 'Arabic';
    win.backgroundColor = BG;
    win.releasedWhenClosed = false;

    root = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    win.contentView = root;
    win.delegate = agent;

    backdrop = panel($.NSMakeRect(0, 0, W, H), BG, null, 0);
    root.addSubview(backdrop);

    setView(SNAPSHOT ? SNAPSHOT_VIEW : (S.landing === 'stats' ? 'stats' : 'home'));

    if (SNAPSHOT) {
        root.displayIfNeeded;
        var rep = root.bitmapImageRepForCachingDisplayInRect(root.bounds);
        root.cacheDisplayInRectToBitmapImageRep(root.bounds, rep);
        rep.representationUsingTypeProperties(
            $.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary)
            .writeToFileAtomically(SNAPSHOT, true);
        $.NSApp.terminate($());
        return;
    }

    win.center;
    grabFocus();
    [0.05, 0.3, 0.8].forEach(function (t) {
        $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
            t, agent, 'grabFocus:', $(), false);
    });
}

function run() { start(); }
function idle() { return 3600; }

start();
if (!/\.app$/.test(ObjC.unwrap($.NSBundle.mainBundle.bundlePath) || '')) {
    $.NSApplication.sharedApplication.run;
}
