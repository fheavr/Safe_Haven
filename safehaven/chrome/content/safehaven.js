/*
 * This function keeps track of redirects for a given page
 * allowing a simple cut of wrt some black and white listed
 * websites
 */

Components.utils.import("resource://gre/modules/NetUtil.jsm");
Components.utils.import("resource://gre/modules/FileUtils.jsm");

const STATE_START           = Ci.nsIWebProgressListener.STATE_START;
const STATE_REDIRECTING     = Ci.nsIWebProgressListener.STATE_REDIRECTING;
const STATE_STOP            = Ci.nsIWebProgressListener.STATE_STOP;
const STATE_IS_WINDOW       = Ci.nsIWebProgressListener.STATE_IS_WINDOW;
const STATE_IS_DOCUMENT     = Ci.nsIWebProgressListener.STATE_IS_DOCUMENT;
const NOTIFY_ALL            = Ci.nsIWebProgress.NOTIFY_ALL;
const NOTIFY_STATE_DOCUMENT = Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT;

// we need to have the number of root redirects passed in
// so that we can keep track of the state the root was in
// when this ad started.
function sh_Ad (pid, cid, root_depth)
{
    this.pid = pid; // id of the parent. for debugging. should always be the root node
    this.cid = cid;
    this.subIds = {};    // the number of times each cid has been redirected
    this.wsubIds = {};   // the sum of all redirections up to cid
    this.hosts = {};     // a list of all of the hosts visited by this ad
    this.hostpaths = {}; // a list of all of the host-paths visited by this ad

    this.subIds[cid] = 1;
    this.wsubIds[cid] = root_depth;
};
// check if parent is in this ad (thus child is also in this ad)
sh_Ad.prototype.inAd = function(pid, cid)
{
    if (this.subIds.hasOwnProperty(cid) ||
        this.subIds.hasOwnProperty(pid)) {return true;}
    else { return false; }
};
sh_Ad.prototype.visitScope = function(pid, cid)
{
    console.log("AdID:" + this.cid + " pid:" + pid + " cid:" + cid);
    if (!this.subIds.hasOwnProperty(cid))
    {
        this.subIds[cid]  = 1;
        this.wsubIds[cid] = this.wsubIds[pid] + 1;
    }
    else
    {
        this.subIds[cid]  += 1;
        this.wsubIds[cid] += 1;
    }
};
sh_Ad.prototype.visitURL = function(host, path)
{
    // count times visited each host
    if (this.hosts.hasOwnProperty(host))
        this.hosts[host] += 1;
    else
        this.hosts[host] = 1;

    // count times visited each hostpath
    if (this.hostpaths.hasOwnProperty(path))
        this.hostpaths[path] += 1;
    else
        this.hostpaths[path] = 1;
};
sh_Ad.prototype.clear = function()
{
    for (var element in this.subIds)    delete this.subIds[element];
    for (var element in this.wsubIds)   delete this.wsubIds[element];
    for (var element in this.hosts)     delete this.hosts[element];
    for (var element in this.hostpaths) delete this.hostpaths[element];
};
sh_Ad.prototype.reinit = function(pid, cid, root_depth)
{
    this.pid = pid;
    this.cid = cid;
    this.subIds[cid] = 1;
    this.wsubIds[cid] = root_depth;
}
/* the largest depth in the add tree accounting for html
 * redirects of each node and number of embedded javascript
 * redirects. The problem is that many ads have a root
 * branching factor greater than 1. (i.e. this doesn't
 *   account for everything) */
sh_Ad.prototype.calc_depth = function()
{
    var count = 0;
    var wTree = this.wsubIds;
    for (var record in wTree)
    {
        if (count < wTree[record])
            count = wTree[record];
    }
    return count;
};
/* the sum of all of the node weights in ad*/
sh_Ad.prototype.calc_sumW = function()
{
    var count = 0;
    var tree = this.subIds;
    for (var record in tree)
    {
        count += tree[record];
    }
    return count;
};
/* the number of different window IDs
 * that were created for this page 
 * BAD METRIC:
 *   scales with number of embedded ads */
sh_Ad.prototype.calc_nodes = function() // can take either tree
{
    var count = 0;
    var tree = this.subIds;
    for (var record in tree) {count++;}
    return count;
};
/* the number of window ids that stop loading, and then
 * begin loading something else. Probably the most
 * traditional definition of redirect
 * BAD METRIC:
 *   scales with the number of ads */
sh_Ad.prototype.calc_reload = function()
{
    var count = 0;
    var tree = this.subIds;
    for (var record in tree)
    {
        if (tree[record] > 1)
            count += Math.floor(tree[record] / 2);
    }
    return count;
};
/* the number of different URL hosts that
 * were queried during this page load.
 * BAD METRIC:
 *   scales with the number of ads? */
sh_Ad.prototype.calc_hostcount = function()
{
    var count = 0;
    var host_list = this.hosts;
    for (var record in host_list) {count++;}
    return count;
};
// NOTE: yes the code is the same, but in theory
// it does not need to stay that way, so the functions
// should be separate
/* the number of different URL host/path
 * combinations that were visited during
 * this page load.
 * BAD METRIC:
 *   scales with the number of ads */
sh_Ad.prototype.calc_pathcount = function()
{
    var count = 0;
    var hostpath_list = this.hostpaths;
    for (var record in hostpath_list) {count++;}
    return count;
};
/* apply chosen metric to determine if this ad
 * is still safe. return true is yes, false if
 * no */
 sh_Ad.prototype.isSafe = function()
 {
    if (this.calc_depth()     > 15 ||
        this.calc_sumW()      > 18 ||
        this.calc_nodes()     > 8  ||
        this.calc_reload()    > 5  ||
        this.calc_hostcount() > 15 ||
        this.calc_pathcount() > 18)
        return false;
    return true;
 };


var safeHaven =
{
    QueryInterface: XPCOMUtils.generateQI(["nsIWebProgressListener",
                                           "nsISupportWeakReference",
                                           "nsISupports"]),

    QueryInterface: function(aIID)
    {
        if (aIID.equals(Components.interfaces.nsIWebProgressListener) ||
          aIID.equals(Components.interfaces.nsISupportsWeakReference) ||
          aIID.equals(Components.interfaces.nsISupports))
           return this;
        throw Components.results.NS_NOINTERFACE;
    },

    sh_tabs: {},   // tab records
    sh_root: {},   // context information for the root node
    sh_wlist: [],  // URL whitelist
    sh_blist: [],  // URL blacklist

    /* INITIALIZATION AND TAB MAMANGEMENT FUNCTIONS */

    init : function()
    {
        this.sh_refreshLists(); // populate our black and white lists

        var Br = gBrowser.browsers;
        for (var i=0, il=Br.length; i<il; i++)
        { this.sh_toggleProgressListener(Br[i].webProgress, true); }

        gBrowser.tabContainer.addEventListener("TabOpen", this, false);
        gBrowser.tabContainer.addEventListener("TabClose", this, false);
    },

    uninit : function()
    {
        var Br = gBrowser.browsers;
        for (var i=0, il=Br.length; i<il; i++)
        { this.sh_toggleProgressListener(Br[i].webProgress, false); }

        gBrowser.tabContainer.removeEventListener("TabOpen", this, false);
        gBrowser.tabContainer.removeEventListener("TabClose", this, false);
    },

    handleEvent : function(aEvent)
    {
        let tab = aEvent.target;
        let webProgress = gBrowser.getBrowserForTab(tab).webProgress;

        this.sh_toggleProgressListener(webProgress, ("TabOpen" == aEvent.type));
    },

    sh_toggleProgressListener : function(aWebProgress, aIsAdd)
    {
        /* all tabs have associated container to store
         * redirect tree */
        var win  = aWebProgress.DOMWindow.wrappedJSObject; // the window/tab triggering the change
        var util = win.QueryInterface(Components.interfaces.nsIInterfaceRequestor).getInterface(Components.interfaces.nsIDOMWindowUtils);
        var cid   = util.outerWindowID;
        if (aIsAdd)
        {
            aWebProgress.addProgressListener(this, NOTIFY_ALL);
            this.sh_tabs[cid] = {};
            this.sh_root[cid] = new sh_Ad(cid, cid, 1);
        }
        else
        {
            aWebProgress.removeProgressListener(this);
            this.sh_cleantab(cid);     // cleanup tab
            delete this.sh_tabs[cid];  // delete tab
            delete this.sh_root[cid]; // delete tab's root counter
        }
    },

    sh_cleantab: function(tid)
    {
        this.sh_root[tid].clear();
        var tab = this.sh_tabs[tid];
        for (var subid in tab)
        {
            tab[subid].clear();
            delete tab[subid];
        }
    },

    /*******************************************
     * WHITE- AND BLACK-LIST RELATED FUNCTIONS */
 
    /* NOTE: for now this file is assumed to exist
     * how it get there is up to the installee :P
     *
     * SafeHavenList.txt must be formated as follows:
     *
     * B"host"path"
     * W"host2"path2"
     * B"host3""
     *
     * where W is white listed and B is black listed.
     * order does not matter.*/
    sh_refreshLists: function()
    {
        var file = FileUtils.getFile("ProfD", ["SafeHavenList.txt"]);
        var sh_wlist = this.sh_wlist;
        var sh_blist = this.sh_blist;

        NetUtil.asyncFetch(file, function (inputStream, status) {
            if (!Components.isSuccessCode(status))
            {
                Cu.reportError('error on file read SuccessCode = ' + status);
                return;
            }
            var data = NetUtil.readInputStreamToString(inputStream, inputStream.available());
            data = data.replace(/\r|\n\r|\t|\s/gm, ""); // remove all white space
            var tmp_arr = data.split("\"");

            for (var i = 0; i+2 < tmp_arr.length; i+=3)
            {
                if (tmp_arr[i] == 'W' || tmp_arr[i] == 'w') {sh_wlist.push(tmp_arr[i+1] + tmp_arr[i+2]);}
                else /* assumed B */ {sh_blist.push(tmp_arr[i+1] + tmp_arr[i+2]);}


                console.log(tmp_arr[i] + "=> " + tmp_arr[i+1] + tmp_arr[i+2]);
            }

        });
    },

    // the list may have a more general host listing,
    // or a more specific host and path listing in the case
    // of websites that host many things
    sh_evalWhiteList: function(URLhost, URLpath)
    {
        var sh_wlist = this.sh_wlist;
        if (URLhost == "") {return false;}

        for (var i = 0; i < sh_wlist.length; i++)
        {
            if (sh_wlist[i] == URLhost ||
                sh_wlist[i] == ("" + URLhost + URLpath))
                return true;
        }
        return false;
    },

    sh_evalBlackList: function(URLhost, URLpath)
    {
        var sh_blist = this.sh_blist;
        if (URLhost == "") {return false;}

        for (var i = 0; i < sh_blist.length; i++)
        {
            if (sh_blist[i] == URLhost ||
                sh_blist[i] == ("" + URLhost + URLpath))
                return true;
        }
        return false;
    },

    /*******************************************
     * REDIRECTION METRIC FUNCTIONS            */

    /* log the state of the completed tab */
    sh_log : function(tid)
    {
        console.log("XX tab(" + tid + ") --STOP event");

        var root = this.sh_root[tid];
        console.log("  root " + root.cid + ":" + root.pid);
        console.log("    IDtree depth = " + root.calc_depth());
        console.log("    IDtree sum   = " + root.calc_sumW());
        console.log("    IDtree node# = " + root.calc_nodes());
        console.log("    IDtree reload# = " + root.calc_reload());
        console.log("    unique hosts = " + root.calc_hostcount());
        console.log("    unique host/paths = " + root.calc_pathcount());

        var tab = this.sh_tabs[tid];
        for (var subid in tab)
        {
            var ad = tab[subid];
            console.log("  ad " + ad.cid + ":" + ad.pid);
            console.log("    IDtree depth = " + ad.calc_depth());
            console.log("    IDtree sum   = " + ad.calc_sumW());
            console.log("    IDtree node# = " + ad.calc_nodes());
            console.log("    IDtree reload# = " + ad.calc_reload());
            console.log("    unique hosts = " + ad.calc_hostcount());
            console.log("    unique host/paths = " + ad.calc_pathcount());
        }
    },

    /*******************************************
     * PROGRESS LISTENER FUNCTIONS             */

    onStateChange: function(aWebProgress, aRequest, aFlag, aStatus)
    {
        var win = aWebProgress.DOMWindow.wrappedJSObject; // the window/tab triggering the change
        var util = win.QueryInterface(Components.interfaces.nsIInterfaceRequestor).getInterface(Components.interfaces.nsIDOMWindowUtils);
        var cid = util.outerWindowID;

        var util2 = win.parent.QueryInterface(Components.interfaces.nsIInterfaceRequestor).getInterface(Components.interfaces.nsIDOMWindowUtils);
        var pid = util2.outerWindowID;
      
        var util3 = win.top.QueryInterface(Components.interfaces.nsIInterfaceRequestor).getInterface(Components.interfaces.nsIDOMWindowUtils);
        var tid = util3.outerWindowID;

        var tab        = this.sh_tabs[tid];
        var root       = this.sh_root[tid];
        var curr_ad    = 'undefined';

        // clean up tab "account" every time the window
        // starts a new request
        if (tid == cid && (aFlag & STATE_IS_WINDOW) && (aFlag & STATE_START))
        {
            this.sh_cleantab(tid);
            root.reinit(pid, tid, 1);
        }

        if (cid == tid) // this even is on the root node
        { // set the root object to record event
            curr_ad = root;
        }
        else // get the ad that this event belongs to
        {
            for (var subid in tab)
            {
                if (tab[subid].inAd(pid, cid))
                {
                    curr_ad = tab[subid];
                    break;
                }
            }
            if (curr_ad === 'undefined')
            { // create the ad if it doesnt exist
                tab[cid] = new sh_Ad(pid, cid, root.calc_depth());
                curr_ad = tab[cid];
            }
        }


        /* NOTE: win.location is the URL of the sending window, NOT the queried URL */
        //console.log("URL: " + win.location.hostname + " _|_ " + win.location.pathname + " => " + aRequest.name);

        /* count the different URLs that are queried */
        if (aRequest instanceof Components.interfaces.nsIHttpChannel)
        {
            var clean_host = aRequest.URI.host;
            var clean_path = aRequest.URI.path.toString();

            // remove query string from the path
            clean_path = clean_path.substring(0, clean_path.indexOf("?"));
            console.log("REQUEST(cid=" + cid + ", pid=" + pid + "): " + clean_host + "_|_" + clean_path);

            // test if on blacklist, if yes abort immediately
            var unsafe = this.sh_evalBlackList(clean_host, clean_path);
            if (unsafe) {aRequest.cancel(Components.results.NS_ERROR_ABORT);}

            var safe = this.sh_evalWhiteList(clean_host, clean_path);
            //TODO: reset counters or something based on distance from
            // white listed sites?

            var full_path = clean_host + clean_path;
            curr_ad.visitURL(clean_host, full_path);
        }

        // keep track of the add scope (frame embeddedness)
        // and actual html redirects
        if (aFlag & STATE_REDIRECTING || // count html redirects as redirects
            ((aFlag & STATE_START) && (aFlag & STATE_IS_DOCUMENT))) // count iframe nesting as redirects
        {
            curr_ad.visitScope(pid, cid);
        }
        else if((aFlag & STATE_STOP) && // even is a termination
                (cid == tid) && (aFlag & STATE_IS_WINDOW)) // this is the termination of top level window
        {
            //console.log("XX --STOP event" + " cid:=" + cid);
            //console.log("STOP flag:" + aFlag + " -- cid:" + cid + " -- pid:" + pid );
            //this.sh_log(cid);
        }

        // if the current ad is not the root document and no longer meets our
        // criteria for safety then nix it. (and change the icon)
        if (!curr_ad.isSafe() && curr_ad.cid != tid)
        {
            aRequest.cancel(Components.results.NS_ERROR_ABORT);
            
            var icon = document.getElementById("sh-status-bar-icon");
            icon.setAttribute("safe", "false");
        }
        else
        {
            var icon = document.getElementById("sh-status-bar-icon");
            icon.setAttribute("safe", "true");
        }
    },

    onLocationChange: function(aWebProgress, aRequest, aURI) {},
    onProgressChange: function(aWebProgress, aRequest, curSelf, maxSelf, curTot, maxTot) {},
    onStatusChange: function(aWebProgress, aRequest, aStatus, aMessage) {},
    onSecurityChange: function(aWebProgress, aRequest, aState) {}
};

window.addEventListener("load", function() { safeHaven.init() }, false);
window.addEventListener("unload", function() { safeHaven.uninit() }, false);