const fs = require("fs");
const jsforce = require("jsforce");
const _async = require("async");
const crypto = require("crypto");
const csv = require("fast-csv");
const mkpath = require("mkpath");
const logger = require("./logger");
const os = require('os');


class SalesforceService {

   constructor(server, startDate) {
        this.connection = new jsforce.Connection({
            loginUrl: server || "https://login.salesforce.com"
        });

        this.csvStream = csv.createWriteStream({headers: true});
        this.requestMap = new Map();
        this.batchStartDate = startDate || null;
        
        this.csvFileName = null;
        this.filesFolder = null;
    }

    createDirectoryAndFileName() {
        logger.info("Checking directory ......." + os.EOL);
        let currentTime = Date.now();
        this.csvFileName = "email_messages_" + currentTime + ".csv";
        this.filesFolder = "files_" + currentTime;

        return new Promise((resolve, reject) => {
            mkpath(this.filesFolder, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    decrypt(content) {
        try {
            let data = Buffer.from(content, "base64");
            let iv = data.slice(0, 16);
            let crypt = data.toString("base64", 16);

            let decipher = crypto.createDecipheriv("aes-256-cbc", SalesforceService.PRIVATE_KEY, iv);
            decipher.setAutoPadding(true);

            let dec = decipher.update(crypt, "base64", "utf-8");
            dec += decipher.final("utf-8");

            return dec;

        } catch(ex) {
            return content;
        }
    }

    formatBytes(bytes, decimals) {
        if (bytes == 0) return "0 Bytes";

        let k = 1024,
            dm = decimals + 1 || 3,
            sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"],
            i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
    }

    calculateFileSize(attachments) {
        let bytes = 0;

        for (let record of attachments) {
            bytes += record.BodyLength;
        }

        logger.info("Total attachments/files: " + attachments.length + os.EOL);
        logger.info("Estimated download size is: " + this.formatBytes(bytes) + os.EOL);
    }

    getQueryStartDate() {
        if (this.batchStartDate !== null && this.batchStartDate !== "" && this.batchStartDate !== undefined) {
            return " AND DAY_ONLY(CreatedDate) >= " + this.batchStartDate;
        }

        return "";
    }

    exportEmailMessages() {
        logger.info("Exporting email messages ....... " + os.EOL);
    
        return new Promise((resolve, reject) => {
            let currentSize = 0;
            let progress = 0;
            let writableStream = fs.createWriteStream(this.csvFileName);

            writableStream.on("finish", function() {
                logger.info("Finished extracting email messages ....... " + os.EOL);
                writableStream.close();
                resolve();
            });

            writableStream.on("error", function(error) {
                logger.error(error);
                reject(error);
            });

            this.csvStream.pipe(writableStream, {encoding: "utf8"});

            let query = this.connection.query("SELECT Id, BccAddress, CcAddress, ToAddress, FromAddress, FromName, Subject, HtmlBody, TextBody, "
                    + "Incoming, HasAttachment, MessageDate, ParentId, Parent.CaseNumber, Parent.Account.FirstName_Encrypted__pc, "
                    + "Parent.Account.LastName_Encrypted__pc, Parent.AccountId, Parent.Account.Corporate_Account_Link__c, Parent.Account.Corporate_Account_Link__r.Name "
                    + "FROM EmailMessage WHERE (Parent.Account.Corporate_Account_Link__r.Name LIKE '%VISA%' " 
                    + "AND Parent.Account.Corporate_Account_Link__r.Name LIKE '%CANADA%')" + this.getQueryStartDate())

            .on("response", (data) => {
                currentSize += data.records.length;
                progress = ((currentSize / data.totalSize) * 100).toFixed(2);

                for (let item of data.records) {
                    this.requestMap.set(item.Id, {
                        Id: item.ParentId, 
                        CaseNumber: item.Parent.CaseNumber
                    });

                    let message = {
                        MessageId: item.Id,
                        BccAddress: item.BccAddress,
                        CcAddress: item.CcAddress,
                        ToAddress: this.decrypt(item.ToAddress),
                        FromAddress: item.FromAddress,
                        FromName: this.decrypt(item.FromName),
                        Subject: this.decrypt(item.Subject),
                        HtmlBody: this.decrypt(item.HtmlBody),
                        TextBody: this.decrypt(item.TextBody),
                        Incoming: item.Incoming,
                        HasAttachment: item.HasAttachment,
                        MessageDate: item.MessageDate,
                        RequestId: item.ParentId,
                        RequestNumber: item.Parent.CaseNumber,
                        MemberId: item.Parent.AccountId,
                        MemberName: item.Parent.Account.FirstName_Encrypted__pc + " " + item.Parent.Account.LastName_Encrypted__pc,
                        CorporateAccountId: item.Parent.Account.Corporate_Account_Link__c,
                        CorporateAccountName: item.Parent.Account.Corporate_Account_Link__r.Name
                    };

                    this.csvStream.write(message);
                }

                if (currentSize >= data.totalSize) {
                    this.csvStream.end();
                }

                logger.info("Fetching records, current size: " + currentSize + "/" + data.totalSize + " - progress: " + progress + "%");
            })
            .on("error", (error) => {
                reject(error);

            }).run({
                autoFetch: true,
                maxFetch: SalesforceService.MAX_FETCH_RECORDS,
                headers: SalesforceService.REST_HEADERS
            });
        });
    }

    getEmailAttachments() {
        logger.info("Quering email attachments ....... " + os.EOL);

        return new Promise((resolve, reject) => {
            let records = [];

            let query = this.connection.query("SELECT Id, ParentId, Name, ContentType, BodyLength FROM Attachment WHERE ParentId IN (SELECT Id FROM EmailMessage WHERE " +
                    "HasAttachment = TRUE AND (Parent.Account.Corporate_Account_Link__r.Name LIKE '%VISA%' " +
                    "AND Parent.Account.Corporate_Account_Link__r.Name LIKE '%CANADA%')" + this.getQueryStartDate() + ") ORDER BY BodyLength DESC")

            .on("record", (record) => {
                records.push(record);
            })
            .on("end", () => {
                resolve(records);
            })
            .on("error", (error) => {
                reject(error);

            }).run({
                autoFetch: true,
                maxFetch: SalesforceService.MAX_FETCH_RECORDS,
                headers: SalesforceService.REST_HEADERS
            });
        });
    }

    async downloadFiles(attachments) {
        logger.info("Downloading email attachments ....... " + os.EOL);

        let queue = _async.queue((record, callback) => {
        let request = this.requestMap.get(record.ParentId);    
        let name = request.Id + "#" + record.ParentId + "#" + record.Name.replace(/[|&;:$%@"<>()+,]/g, "");
        let file = fs.createWriteStream(this.filesFolder + "/" + name);

        file.on("finish", () => {
            let count = 0;
            logger.info("Downloaded " + name + " .......");

            _async.whilst( //wait 8 seconds
                function() {
                    return count < 1;
                },
                function(callback) {
                    count++;

                    setTimeout(function() {
                        callback();
                    }, SalesforceService.NEXT_BATCH_TIME);
                },
                function(err, n) {
                    callback();
                });
        });

        file.on("error", (error) => {
            logger.error(error);
            callback();
        });

        this.connection.sobject("Attachment").record(record.Id).blob("Body").pipe(file)
            .on("error", (error) => {
                logger.error(error);
            });

        }, SalesforceService.MAX_BATCH_DOWNLOADS);

        queue.drain = function() {
            //all tasks done.
            logger.info("Finished .......");
        };

        return await queue.push(attachments);
    }

    static get PRIVATE_KEY() {
        return Buffer.from("YOUR_PRIVATE_KEY", "base64");
    }

    static get MAX_FETCH_RECORDS() {
        return 1000000;
    }

    static get REST_HEADERS() {
        return {
            "Sforce-Query-Options": "batchSize=2000"
        };
    }

    static get MAX_BATCH_DOWNLOADS() {
        return 50;
    }

    static get NEXT_BATCH_TIME() {
        return 8000;
    }
}

module.exports = SalesforceService;