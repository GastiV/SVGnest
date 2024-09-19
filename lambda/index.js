const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const os = require("os");
const AWS = require('aws-sdk');
const {randomUUID} = require("crypto");

const config = {
    accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID || "dummy_key",
    secretAccessKey: process.env.AWS_S3_ACCESS_KEY_SECRET || "dummy_secret",
    region: process.env.AWS_S3_BUCKET_REGION || "us-east-2",
    bucketName: process.env.AWS_S3_BUCKET_NAME || "servicio-de-tizada",
    nestingServiceHost: process.env.NESTING_SERVICE_HOST || "https://svg-nest.netlify.app/",
}

// Configure AWS SDK
AWS.config.update({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
});


exports.handler = async (event, context, callback) => {

    console.log(`Lambda triggered!!!\n`);
    console.log("EVENT: \n" + JSON.stringify(event, null, 2));

    const logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.json(),
        transports: [
            new winston.transports.Console(),
        ],
    });
    logger.defaultMeta = {requestId: context.awsRequestId};

    let browser = null;
    let output = null;

    try {

        logger.info("Before setup");

        const {
            iterationCount,
            efficiency,
            selectors,
            tmpPath,
            timeout
        } = await initialSetup(event);
        logger.info("After setup");

        logger.info("Before browser");
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
            timeout: 0
        });
        logger.info("After browser");

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(12000000);

        logger.info("New page");
        await page.goto(config.nestingServiceHost);

        page.on('console', msg => logger.info('PAGE LOG', {data: msg.text()}));

        const partsPath = path.join(tmpPath, 'parts.svg');
        const partsInput = await page.waitForSelector('#fileinput');
        await partsInput.uploadFile(partsPath);
        const binPath = path.join(tmpPath, 'bin.svg');
        const binInput = await page.waitForSelector('#bininput');
        await binInput.uploadFile(binPath);
        fs.rmSync(tmpPath, {recursive: true, force: true});
        const startButton = await page.waitForSelector('#start');
        await startButton.click();

        let defaultIterationCount = 10;

        let screenshot = await page.screenshot({ encoding: 'base64' });

        logger.info(JSON.stringify({
            message: 'Screenshot taken',
            screenshot: screenshot, // The base64-encoded image can be stored or returned
        }));

        logger.info("Before waitForValueChange");
        await waitForValueChange(page, selectors, iterationCount || defaultIterationCount, timeout, efficiency);

        screenshot = await page.screenshot({ encoding: 'base64' });

        logger.info(JSON.stringify({
            message: 'Screenshot taken',
            screenshot: screenshot, // The base64-encoded image can be stored or returned
        }));

        logger.info("After waitForValueChange");
        logger.info("Before sendButton");
        const sendButton = await page.waitForSelector('#sendresult');
        await sendButton.click();
        logger.info("After sendButton click");

        output = await page.evaluate(() => {
            return localStorage.getItem('svgOutput');
        });
        logger.info("After output");

        logger.info("Chromium:", await browser.version());
        logger.info("Page Title:", await page.title());
        logger.info("SVG Output:", output);

        const data = await uploadSVGToS3(config.bucketName, output);
        console.log(`S3 Upload Data: ${data}`);

    } catch (error) {
        logger.info("Error message");
        logger.info(error.message);
        return error;
    } finally {
        logger.info("Finally message");
        for (const page of await browser.pages()) {
            await page.close();
        }
        await browser.close();
    }
    logger.info("Before callback");
    return output;
}

async function buildSVGPart(userIdentifier, parts, fileName) {
    const svgFiles = parts.map(part => {
        return {
            bucket: process.env.AWS_S3_BUCKET_NAME || "servicio-de-tizada",
            key: `${userIdentifier}/${part.uuid}.svg`,
            count: part.quantity
        };
    });

    try {
        return await combineSvgs(svgFiles);
    } catch (error) {
        console.error(`Error trying to combine SVG: ${error.message}`);
    }

}

// Function to extract the inner content of an SVG file and sanitize IDs
function sanitizeSvgContent(svgContent, uniquePrefix) {
    let sanitizedContent = svgContent
        .replace(/<\?xml[^>]+\?>/g, '') // Remove XML declaration
        .replace(/<svg[^>]*>/, '') // Remove opening <svg> tag
        .replace(/<\/svg>/, ''); // Remove closing </svg> tag

    sanitizedContent = sanitizedContent.replace(/id="([^"]+)"/g, `id="${uniquePrefix}-$1"`);
    sanitizedContent = sanitizedContent.replace(/href="#([^"]+)"/g, `href="#${uniquePrefix}-$1"`); // Update hrefs

    return sanitizedContent;
}

// Function to fetch an SVG file from AWS S3
async function fetchSvgFromS3(bucket, key) {

    // Configure the AWS SDK
    const s3 = new AWS.S3(config);

    try {
        const params = {
            Bucket: bucket,
            Key: key,
        };
        const data = await s3.getObject(params).promise();
        return data.Body.toString('utf-8'); // Convert the file content to a string
    } catch (error) {
        console.error(`Failed to fetch SVG from S3: ${error.message}`);
        throw error;
    }
}

// Fetch SVG files, repeat them based on count, and combine
async function combineSvgs(svgFiles) {
    let combinedSvgContent = '';

    for (const [index, svgFile] of svgFiles.entries()) {
        try {
            const svgContent = await fetchSvgFromS3(svgFile.bucket, svgFile.key);
            const uniquePrefix = `file${index + 1}`;
            const sanitizedContent = sanitizeSvgContent(svgContent, uniquePrefix);

            // Repeat the SVG content based on the count
            for (let i = 0; i < svgFile.count; i++) {
                combinedSvgContent += `${sanitizedContent}\n`;
            }
        } catch (error) {
            console.error(`Error fetching or processing SVG from S3 bucket: ${svgFile.bucket}`);
        }
    }

    // Create the combined SVG content with one root <svg> element
    const outputSvgContent = `
    <svg xmlns="http://www.w3.org/2000/svg" height="3000" width="3000" viewBox="0 0 3000 3000" style="background-color:white">
        ${combinedSvgContent}
    </svg>
    `;

    console.log(`Combined SVG result ${outputSvgContent}`);
    return outputSvgContent;
}

async function initialSetup(payload) {
    const jsonString = `{
                "svgBin": "<svg width='2000' height='2000' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2048 2048'><rect width='511.822' height='339.235' fill='grey' stroke='#010101'/></svg>",
                "svgParts": "<svg width='2000' height='2000' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2048 2048'><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='582.528,372.964 624.57,373.468 631.906,347.062 620.936,326.309 609.533,329.092 592.663,309.654 560.571,335.878 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='661.185,157.016 652.101,203.035 718.574,209.716 734.568,180.887 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='661.185,157.016 652.101,203.035 718.574,209.716 734.568,180.887 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='661.185,157.016 652.101,203.035 718.574,209.716 734.568,180.887 '/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><polygon fill='green' stroke='#010101' stroke-miterlimit='10' points='1057.909,602.939 1049.363,604.521 1043.723,597.907 1046.628,589.714 1055.174,588.14 1060.814,594.753'/><g id='part24' class='part active' style='transform: translate(586.0717408999999px, -161.09737510000002px) rotate(90deg)'><path id='_x36_3-Science_x5F_Centre' fill='green' stroke='#ffffff' stroke-width='0.7056' stroke-linecap='round' stroke-linejoin='bevel' d='M 488.63399999999996 280.125 L 525.1724999999999 263.06775 C 525.1724999999999 263.06775 532.85925 286.53075 535.7782499999998 298.5495 C 539.0939999999999 312.20025000000004 541.6987499999999 326.067 543.5917499999999 340.02375 C 545.5065 354.1245 547.0484999999999 368.349 547.1624999999999 382.59675000000004 C 547.2734999999999 396.5295 545.7457499999998 410.43600000000004 544.3364999999999 424.28774999999996 C 543.0052499999999 437.37749999999994 541.4332499999998 450.46574999999996 539.0219999999998 463.3785 C 536.9167499999999 474.64725 534.5024999999998 485.8995 531.0494999999999 496.782 C 525.8362499999998 513.213 518.6159999999999 528.84 511.90049999999985 544.63425 C 508.02224999999976 553.7549999999999 499.6964999999998 571.71225 499.6964999999998 571.71225 L 488.7524999999998 586.07175 L 488.63399999999996 280.125 z' fill-opacity='1'/></g><g id='part24' class='part active' style='transform: translate(586.0717408999999px, -161.09737510000002px) rotate(90deg)'><path id='_x36_3-Science_x5F_Centre' fill='green' stroke='#ffffff' stroke-width='0.7056' stroke-linecap='round' stroke-linejoin='bevel' d='M 488.63399999999996 280.125 L 525.1724999999999 263.06775 C 525.1724999999999 263.06775 532.85925 286.53075 535.7782499999998 298.5495 C 539.0939999999999 312.20025000000004 541.6987499999999 326.067 543.5917499999999 340.02375 C 545.5065 354.1245 547.0484999999999 368.349 547.1624999999999 382.59675000000004 C 547.2734999999999 396.5295 545.7457499999998 410.43600000000004 544.3364999999999 424.28774999999996 C 543.0052499999999 437.37749999999994 541.4332499999998 450.46574999999996 539.0219999999998 463.3785 C 536.9167499999999 474.64725 534.5024999999998 485.8995 531.0494999999999 496.782 C 525.8362499999998 513.213 518.6159999999999 528.84 511.90049999999985 544.63425 C 508.02224999999976 553.7549999999999 499.6964999999998 571.71225 499.6964999999998 571.71225 L 488.7524999999998 586.07175 L 488.63399999999996 280.125 z' fill-opacity='1'/></g><g id='part24' class='part active' style='transform: translate(586.0717408999999px, -161.09737510000002px) rotate(90deg)'><path id='_x36_3-Science_x5F_Centre' fill='green' stroke='#ffffff' stroke-width='0.7056' stroke-linecap='round' stroke-linejoin='bevel' d='M 488.63399999999996 280.125 L 525.1724999999999 263.06775 C 525.1724999999999 263.06775 532.85925 286.53075 535.7782499999998 298.5495 C 539.0939999999999 312.20025000000004 541.6987499999999 326.067 543.5917499999999 340.02375 C 545.5065 354.1245 547.0484999999999 368.349 547.1624999999999 382.59675000000004 C 547.2734999999999 396.5295 545.7457499999998 410.43600000000004 544.3364999999999 424.28774999999996 C 543.0052499999999 437.37749999999994 541.4332499999998 450.46574999999996 539.0219999999998 463.3785 C 536.9167499999999 474.64725 534.5024999999998 485.8995 531.0494999999999 496.782 C 525.8362499999998 513.213 518.6159999999999 528.84 511.90049999999985 544.63425 C 508.02224999999976 553.7549999999999 499.6964999999998 571.71225 499.6964999999998 571.71225 L 488.7524999999998 586.07175 L 488.63399999999996 280.125 z' fill-opacity='1'/></g><g id='part24' class='part active' style='transform: translate(586.0717408999999px, -161.09737510000002px) rotate(90deg)'><path id='_x36_3-Science_x5F_Centre' fill='green' stroke='#ffffff' stroke-width='0.7056' stroke-linecap='round' stroke-linejoin='bevel' d='M 488.63399999999996 280.125 L 525.1724999999999 263.06775 C 525.1724999999999 263.06775 532.85925 286.53075 535.7782499999998 298.5495 C 539.0939999999999 312.20025000000004 541.6987499999999 326.067 543.5917499999999 340.02375 C 545.5065 354.1245 547.0484999999999 368.349 547.1624999999999 382.59675000000004 C 547.2734999999999 396.5295 545.7457499999998 410.43600000000004 544.3364999999999 424.28774999999996 C 543.0052499999999 437.37749999999994 541.4332499999998 450.46574999999996 539.0219999999998 463.3785 C 536.9167499999999 474.64725 534.5024999999998 485.8995 531.0494999999999 496.782 C 525.8362499999998 513.213 518.6159999999999 528.84 511.90049999999985 544.63425 C 508.02224999999976 553.7549999999999 499.6964999999998 571.71225 499.6964999999998 571.71225 L 488.7524999999998 586.07175 L 488.63399999999996 280.125 z' fill-opacity='1'/></g><g id='part24' class='part active' style='transform: translate(586.0717408999999px, -161.09737510000002px) rotate(90deg)'><path id='_x36_3-Science_x5F_Centre' fill='green' stroke='#ffffff' stroke-width='0.7056' stroke-linecap='round' stroke-linejoin='bevel' d='M 488.63399999999996 280.125 L 525.1724999999999 263.06775 C 525.1724999999999 263.06775 532.85925 286.53075 535.7782499999998 298.5495 C 539.0939999999999 312.20025000000004 541.6987499999999 326.067 543.5917499999999 340.02375 C 545.5065 354.1245 547.0484999999999 368.349 547.1624999999999 382.59675000000004 C 547.2734999999999 396.5295 545.7457499999998 410.43600000000004 544.3364999999999 424.28774999999996 C 543.0052499999999 437.37749999999994 541.4332499999998 450.46574999999996 539.0219999999998 463.3785 C 536.9167499999999 474.64725 534.5024999999998 485.8995 531.0494999999999 496.782 C 525.8362499999998 513.213 518.6159999999999 528.84 511.90049999999985 544.63425 C 508.02224999999976 553.7549999999999 499.6964999999998 571.71225 499.6964999999998 571.71225 L 488.7524999999998 586.07175 L 488.63399999999996 280.125 z' fill-opacity='1'/></g><g id='part24' class='part active' style='transform: translate(586.0717408999999px, -161.09737510000002px) rotate(90deg)'><path id='_x36_3-Science_x5F_Centre' fill='green' stroke='#ffffff' stroke-width='0.7056' stroke-linecap='round' stroke-linejoin='bevel' d='M 488.63399999999996 280.125 L 525.1724999999999 263.06775 C 525.1724999999999 263.06775 532.85925 286.53075 535.7782499999998 298.5495 C 539.0939999999999 312.20025000000004 541.6987499999999 326.067 543.5917499999999 340.02375 C 545.5065 354.1245 547.0484999999999 368.349 547.1624999999999 382.59675000000004 C 547.2734999999999 396.5295 545.7457499999998 410.43600000000004 544.3364999999999 424.28774999999996 C 543.0052499999999 437.37749999999994 541.4332499999998 450.46574999999996 539.0219999999998 463.3785 C 536.9167499999999 474.64725 534.5024999999998 485.8995 531.0494999999999 496.782 C 525.8362499999998 513.213 518.6159999999999 528.84 511.90049999999985 544.63425 C 508.02224999999976 553.7549999999999 499.6964999999998 571.71225 499.6964999999998 571.71225 L 488.7524999999998 586.07175 L 488.63399999999996 280.125 z' fill-opacity='1'/></g><g id='part24' class='part active' style='transform: translate(586.0717408999999px, -161.09737510000002px) rotate(90deg)'><path id='_x36_3-Science_x5F_Centre' fill='green' stroke='#ffffff' stroke-width='0.7056' stroke-linecap='round' stroke-linejoin='bevel' d='M 488.63399999999996 280.125 L 525.1724999999999 263.06775 C 525.1724999999999 263.06775 532.85925 286.53075 535.7782499999998 298.5495 C 539.0939999999999 312.20025000000004 541.6987499999999 326.067 543.5917499999999 340.02375 C 545.5065 354.1245 547.0484999999999 368.349 547.1624999999999 382.59675000000004 C 547.2734999999999 396.5295 545.7457499999998 410.43600000000004 544.3364999999999 424.28774999999996 C 543.0052499999999 437.37749999999994 541.4332499999998 450.46574999999996 539.0219999999998 463.3785 C 536.9167499999999 474.64725 534.5024999999998 485.8995 531.0494999999999 496.782 C 525.8362499999998 513.213 518.6159999999999 528.84 511.90049999999985 544.63425 C 508.02224999999976 553.7549999999999 499.6964999999998 571.71225 499.6964999999998 571.71225 L 488.7524999999998 586.07175 L 488.63399999999996 280.125 z' fill-opacity='1'/></g><g id='part24' class='part active' style='transform: translate(586.0717408999999px, -161.09737510000002px) rotate(90deg)'><path id='_x36_3-Science_x5F_Centre' fill='green' stroke='#ffffff' stroke-width='0.7056' stroke-linecap='round' stroke-linejoin='bevel' d='M 488.63399999999996 280.125 L 525.1724999999999 263.06775 C 525.1724999999999 263.06775 532.85925 286.53075 535.7782499999998 298.5495 C 539.0939999999999 312.20025000000004 541.6987499999999 326.067 543.5917499999999 340.02375 C 545.5065 354.1245 547.0484999999999 368.349 547.1624999999999 382.59675000000004 C 547.2734999999999 396.5295 545.7457499999998 410.43600000000004 544.3364999999999 424.28774999999996 C 543.0052499999999 437.37749999999994 541.4332499999998 450.46574999999996 539.0219999999998 463.3785 C 536.9167499999999 474.64725 534.5024999999998 485.8995 531.0494999999999 496.782 C 525.8362499999998 513.213 518.6159999999999 528.84 511.90049999999985 544.63425 C 508.02224999999976 553.7549999999999 499.6964999999998 571.71225 499.6964999999998 571.71225 L 488.7524999999998 586.07175 L 488.63399999999996 280.125 z' fill-opacity='1'/></g></svg>",
                "iterationCount": "5",
                "efficiency": "50"
            }`

    const jsonObject = JSON.parse(jsonString);

    const svgBin = await buildSVGPart(payload.user, [payload.bin]) || jsonObject.svgBin;
    const svgParts = await buildSVGPart(payload.user, payload.parts) || jsonObject.svgParts;
    const {maxIterations, materialUtilization, timeout} = payload.configuration;
    const iterationCount = maxIterations || jsonObject.iterationCount;
    const efficiency = materialUtilization || jsonObject.efficiency;

    const selectors = {
        info_iterations: "#info_iterations",
        info_placed: "#info_placed",
        info_efficiency: "#info_efficiency",
        info_progress: "#info_progress",
    };

    // temporary directory to write bin and parts in order to send path to uploadFile(): TODO find a cleaner way to do it
    const tmpPath = path.join('/tmp', '/tizada');
    fs.mkdirSync(tmpPath, {recursive: true});
    fs.writeFileSync(path.join(tmpPath, 'bin.svg'), svgBin, 'utf-8');

    fs.writeFileSync(path.join(tmpPath, 'parts.svg'), svgParts, 'utf-8');
    return {iterationCount, efficiency, selectors, tmpPath, timeout};
}

// observe for changes in selector, resolve if value reach targetValue, reject if timeout
async function waitForValueChange(page, selectors, iterationCount, timeout, efficiency) {
    return (await page.evaluate((selectors, targetValue, timeout) => {
        return (new Promise((resolve, reject) => {
            const info_iterations = document.querySelector(selectors.info_iterations);
            const info_efficiency = document.querySelector(selectors.info_efficiency);
            const info_placed = document.querySelector(selectors.info_placed);

            // Ensure elements are available
            if (!info_iterations || !info_efficiency || !info_placed) {
                console.error('Required elements not found in the DOM');
                return reject(new Error('DOM elements not found'));
            }

            console.log(`Parts placed: ${info_placed.textContent}`);

            const observer = new MutationObserver(() => {

                if (parseFloat(info_iterations.textContent) === parseFloat(targetValue)) {
                    console.log('Max iterations reached!')
                    observer.disconnect();
                    resolve();
                }

                if (parseFloat(efficiency) >= parseFloat(info_efficiency.textContent)) {
                    console.log('Efficiency threshold reached!');
                    console.log(`Efficiency limit: ${efficiency}`);
                    console.log(`Efficiency reached: ${info_efficiency.textContent}`);
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(info_iterations, {childList: true});
            observer.observe(info_efficiency, { childList: true });
            if (timeout) {
                setTimeout(() => {
                    observer.disconnect();
                    reject(new Error(`Timeout waiting for value change in ${selectors.info_iterations}: ${info_iterations} ${info_iterations.textContent} or ${selectors.info_efficiency}: ${info_efficiency} ${info_efficiency.textContent}`));
                    reject(new Error(`Timeout waiting for value change in ${selectors.info_iterations}: ${info_iterations} ${parseFloat(info_iterations.textContent)} or ${selectors.info_efficiency}: ${info_efficiency} ${parseFloat(info_efficiency.textContent)}`));
                }, timeout)
            }
        }))
    }, selectors, iterationCount, timeout, efficiency))
}

const uploadSVGToS3 = async (bucketName, svgOutput) => {

    try {
        const s3 = new AWS.S3({apiVersion: "2006-03-01"});
        const keyPrefix = 'result/' + randomUUID() + '/'; // Optional: specify a folder in the bucket

        const tmpPath = path.join('/tmp', '/tizada');
        fs.mkdirSync(tmpPath, {recursive: true});
        fs.writeFileSync(path.join(tmpPath, 'result.svg'), svgOutput, 'utf-8');

        const filePath = path.join(tmpPath, 'result.svg');

        const fileName = path.basename(filePath);
        const fileContent = fs.readFileSync(filePath);

        const params = {
            Bucket: bucketName,
            Key: keyPrefix + fileName,
            Body: fileContent,
            ContentType: 'image/svg+xml'
        };

        const data = await s3.upload(params).promise();
        console.log(`File uploaded successfully. ${data.Location}`);
        return data;
    } catch (error) {
        console.error('Error uploading to S3:', error);
        throw error;
    }
};
