// Dock / Applications entry point for the Learnmax.
//
// Compiled into "Learnmax.app" by install.sh, which bakes the drill
// directory in below. All it does is start home.py on the home screen and
// get out of the way -- the windows themselves belong to LearnmaxHome.app and
// LearnmaxDrill.app, which home.py opens.
//
// home.py refuses to start a second copy itself, via a pidfile.

ObjC.import('Cocoa');

// install.sh replaces the placeholder at build time. Unreplaced (the applet
// was compiled by hand into the drill directory itself), fall back to the
// directory the .app bundle sits in.
var DIR = '__DRILL_DIR__';
if (DIR.indexOf('__') === 0) {
    var bp = ObjC.unwrap($.NSBundle.mainBundle.bundlePath) || '';
    DIR = bp.replace(/\/[^\/]+\.app$/, '');
}
var HOME = DIR + '/home.py';

function run() {
    // No guard here on purpose: any pgrep pattern for home.py also matches
    // this launcher's own command line, so it would always match itself and
    // never start anything. home.py enforces the single instance via pidfile.
    var script = 'nohup /usr/bin/python3 ' + HOME +
                 ' >/dev/null 2>&1 &';
    var task = $.NSTask.alloc.init;
    task.launchPath = '/bin/sh';
    task.arguments = ['-c', script];
    task.launch;
    // Give the shell a moment to fork before this process disappears.
    $.NSThread.sleepForTimeInterval(0.4);
    $.NSApp.terminate($());
}
