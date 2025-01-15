const { expect } = require('chai');

/**
 * Expect an async function to throw
 * @param {*} func Async function to be tested
 * @param {*} errorMessage Error message to be expected, can be a string or a RegExp
 */
const expectThrowsAsync = async (func, errorMessage) => {
    let error = null;
    try {
        await func();
    } catch (err) {
        error = err;
    }
    expect(error).to.be.an('Error');
    if (errorMessage) {
        if (errorMessage instanceof RegExp) {
            expect(error.message).to.match(errorMessage);
        } else {
            expect(error.message).to.contain(errorMessage);
        }
    }
};

exports.expectThrowsAsync = expectThrowsAsync;
