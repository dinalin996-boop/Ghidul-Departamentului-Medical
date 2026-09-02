/* Compatibility boundary for the repartizare feature. */
(function (window) {
    'use strict';

    window.medicalRepartizare = window.medicalRepartizare || {};
    window.medicalRepartizare.ready = function () {
        return typeof window.rpStartPolling === 'function';
    };
})(window);
