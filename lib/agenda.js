var Job = require('./job.js'),
    humanInterval = require('human-interval'),
    utils = require('util'),
    Emitter = require('events').EventEmitter,
    mongo = require('mongoskin');

var Agenda = module.exports = function (config) {
    if (!(this instanceof Agenda)) return new Agenda(config);
    if (!config) config = {};
    this._processEvery = humanInterval(config.processEvery) || humanInterval('5 seconds');
    this._defaultConcurrency = config.defaultConcurrency || 5;
    this._maxConcurrency = config.maxConcurrency || 20;
    this._definitions = {};
    this._runningJobs = 0;
    if (config.db && config.db.address)
        this.database(config.db.address, config.db.collection);
    else if (config.mongo)
        this._db = config.mongo.collection((config.db && config.db.collection) ||'agendaJobs');
    else if (config.mongodb)
        this._db = config.mongodb;
};

utils.inherits(Agenda, Emitter);

// Configuration Methods

Agenda.prototype.database = function (url, collection) {
    collection = collection || 'agendaJobs';
    this._db = mongo.db(url, {w: 0}).collection(collection);
    return this;
};

Agenda.prototype.processEvery = function (time) {
    this._processEvery = humanInterval(time);
    return this;
};

Agenda.prototype.maxConcurrency = function (num) {
    this._maxConcurrency = num;
    return this;
};

Agenda.prototype.defaultConcurrency = function (num) {
    this._defaultConcurrency = num;
    return this;
};

// Job Methods
Agenda.prototype.create = function (name, data) {
    var priority = this._definitions[name] ? this._definitions[name].priority : 0;
    var job = new Job({name: name, data: data, type: 'normal', priority: priority, agenda: this});
    return job;
};

Agenda.prototype.jobs = function () {
    var args = Array.prototype.slice.call(arguments);

    if (typeof args[args.length - 1] == 'function') {
        args.push(findJobsResultWrapper(this, args.pop()));
    }

    return this._db.findItems.apply(this._db, args);
};

Agenda.prototype.define = function (name, options, processor) {
    if (!processor) {
        processor = options;
        options = {};
    }
    this._definitions[name] = {
        fn: processor,
        concurrency: options.concurrency || this._defaultConcurrency,
        priority: options.priority || 0,
        lockLifetime: options.lockLifetime || 10 * 60 * 1000,//10 minute default lockLifetime
        running: 0
    };
};

Agenda.prototype.every = function (interval, name, data) {
    var job;
    job = this.create(name, data);
    job.attrs.type = 'single';
    job.repeatEvery(interval);
    job.save();
    return job;
};

Agenda.prototype.schedule = function (when, name, data) {
    var job = this.create(name, data);
    job.schedule(when);
    job.save();
    return job;
};

Agenda.prototype.now = function (name, data) {
    var job = this.create(name, data);
    job.schedule(new Date());
    job.save();
    return job;
};

Agenda.prototype.saveJob = function (job, cb) {
    var fn = cb;

    var props = job.toJSON();

    delete props._id;

    if (props.type == 'single')
        this._db.findAndModify({name: props.name, type: 'single'}, {}, {$set: props}, {upsert: true, new: true}, processDbResult);
    else {
        if (job.attrs._id) {
            this._db.findAndModify({_id: job.attrs._id}, {}, {$set: props}, {new: true}, processDbResult);
        }
        else {
            this._db.insert(props, processDbResult);
        }
    }

    function processDbResult(err, res) {
        if (err) throw(err);
        else if (res) {
            if (Array.isArray(res)) {
                job.attrs._id = res[0]._id;
            } else if (typeof res == 'object') {
                job.attrs._id = res._id;
            }
        }

        if (fn) {
            fn(err, job);
        }
    }
};

// Job Flow Methods

Agenda.prototype.start = function () {
    if (!this._processInterval) {
        this._processInterval = setInterval(this.processJobs.bind(this), this._processEvery);
        process.nextTick(this.processJobs.bind(this));
    }
};

Agenda.prototype.limitedStart = function (count, name) {
    this.processJobs(count, name);
};

Agenda.prototype.stop = function () {
    clearInterval(this._processInterval);
    this._processInterval = undefined;
};

/**
 * Find and lock jobs
 * @param {String} jobName
 * @param {Function} cb
 * @protected
 */
Agenda.prototype._findAndLockNextJob = function (jobName, definition, cb) {


    var now = new Date(),
        lockDeadline = new Date(Date.now().valueOf() - definition.lockLifetime);

    var filter = {
        nextRunAt: {$lte: now},
        $or: [
            {lockedAt: null},
            {lockedAt: {$exists: false}},
            {lockedAt: {$lte: lockDeadline}}
        ]
    };

    if (Array.isArray(jobName)) {
        filter.name = {$in: jobName }
    } else if (jobName) {
        filter.name = jobName
    }

    this._db.findAndModify(
        filter
        ,
        {'priority': -1},
        {$set: {lockedAt: now}},
        {'new': true},
        findJobsResultWrapper(this, cb)
    );
};

/**
 *
 * @param agenda
 * @param cb
 * @return {Function}
 * @private
 */
function findJobsResultWrapper(agenda, cb) {
    return function (err, jobs) {
        if (jobs) {
            //query result can be array or one record
            if (jobs instanceof Array) {
                jobs = jobs.map(createJob.bind(null, agenda));
            } else {
                jobs = createJob(agenda, jobs);
            }
        }

        cb(err, jobs);
    };
}

/**
 * Create Job object from data
 * @param {Object} agenda
 * @param {Object} jobData
 * @return {Job}
 * @private
 */
function createJob(agenda, jobData) {
    jobData.agenda = agenda;
    return new Job(jobData);
}

Agenda.prototype.processJobs = function (count, name) {
    var definitions = this._definitions,
        jobQueue = [],
        self = this;

    function jobQueueFilling(name) {

        var jobDef = {lockLifetime: 10 * 60 * 1000}
        if (!name) {
            name = []
            for (var job in definitions)
                name.push(job);
        }


        self._findAndLockNextJob(name, jobDef, function (err, job) {
            if (err) {
                throw err;
            }

            if (job) {
                jobQueue.push(job);

                if (count === undefined || count === null) {
                    global.setImmediate(function () {
                        jobQueueFilling(name);
                    })
                } else if (--count > 0) {
                    global.setImmediate(function () {

                        jobQueueFilling(name);
                    })
                }


                jobProcessing();
            }
        });
    }

    function jobProcessing() {
        if (!jobQueue.length) {
            return;
        }

        var job = jobQueue.pop(),
            name = job.attrs.name,
            jobDefinition = definitions[name];

        if (jobDefinition.concurrency > jobDefinition.running &&
            self._runningJobs < self._maxConcurrency) {

            self._runningJobs++;
            jobDefinition.running++;

            job.run(processJobResult);
            jobProcessing();
        } else {
            jobQueue.unshift(job);
        }
    }

    function processJobResult(err, job) {
        var name = job.attrs.name;

        self._runningJobs--;
        definitions[name].running--;

        jobProcessing();
    }

    if (name) {
        jobQueueFilling(name);
    } else {

        jobQueueFilling();
    }
}
