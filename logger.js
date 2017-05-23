const winston = require('winston');
winston.emitErrs = true;

const logger = new winston.Logger({
    transports: [
        new winston.transports.File({
            filename: 'job.log',
            handleExceptions: true,
            colorize: false,
            json: false
        }),
        new winston.transports.Console({
            handleExceptions: true,
            json: false,
            colorize: true
        })
    ],
    exitOnError: false
});

module.exports = logger;
module.exports.stream = {
    write: function(message, encoding) {
        logger.info(message);
    }
};