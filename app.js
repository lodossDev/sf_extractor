const SalesforceService = require("./salesforce_service");
const logger = require("./logger");
const os = require('os');


async function main() {
    try {
        let instance = process.argv[2];
        let username = process.argv[3];
        let password = process.argv[4];
        let startDate = process.argv[5];

        logger.info("Connecting to salesforce ......." + os.EOL);
        logger.info("Username: " + username);
        
        const sforce = new SalesforceService(instance, startDate);
        let login = await sforce.connection.login(username, password);

        logger.info("User Id: " + login.id);
        logger.info("Org Id: " + login.organizationId);
        logger.info("Will use batch start date: " + sforce.getQueryStartDate());

        await sforce.createDirectoryAndFileName();

        await sforce.exportEmailMessages();

        let emailAttachments = await sforce.getEmailAttachments();
        sforce.calculateFileSize(emailAttachments);

        await sforce.downloadFiles(emailAttachments);

    } catch(ex) {
        logger.info(ex);
    }
}

main();