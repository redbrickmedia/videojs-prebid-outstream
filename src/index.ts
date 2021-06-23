import videojs, { VideoJsPlayer } from 'video.js';
import { VastCreativeLinear, VastCreative, VastMediaFile, VastAd, VASTTracker } from 'vast-client';

import { displayVPAID } from './vpaid';
import { displayVASTNative, parseVAST } from './vast';
import { getLogger, ILogger } from './logger';
import CloseComponent from './component/close';
import { createTracker } from './tracker';
import VastError, { LINEAR_ERROR, VAST_NO_ADS } from './errors';

import './index.css';

export type PrebidOutStreamPluginOptions = PrebidOutStreamPlugin.Options;

export interface BaseProps {
    options: PrebidOutStreamPlugin.Options;
    player: VideoJsPlayer;
    logger: ILogger;
}

export interface BaseWithCreative extends BaseProps {
    display: DisplayMedia;
}

export interface BaseWithCreativeAndTracker extends BaseWithCreative {
    tracker: VASTTracker;
}

interface DisplayMedia {
    ad: VastAd;
    creative: VastCreativeLinear;
    media: VastMediaFile;
}

// TODO
// When destroyed, clear all listeners on window
// When destroyed, clear vpaid container
export default function register(vjs: typeof videojs = videojs) {
    const vjsPlugin = vjs.getPlugin('plugin');

    const Plugin = class Plugin extends vjsPlugin implements PrebidOutStreamPlugin.Instance {
        player: VideoJsPlayer;
        options: PrebidOutStreamPlugin.Options;

        constructor(player: VideoJsPlayer, options?: PrebidOutStreamPlugin.Options) {
            super(player, options);

            this.player = player;

            // Set option defaults
            const adControls = {
                ...{
                    volumePanel: true,
                    playToggle: false,
                    captionsButton: true,
                    chaptersButton: false,
                    subtitlesButton: false,
                    remainingTimeDisplay: true,
                    progressControl: false,
                    fullscreenToggle: true,
                    playbackRateMenuButton: false,
                    pictureInPictureToggle: false,
                    currentTimeDisplay: false,
                    timeDivider: false,
                    durationDisplay: false,
                    liveDisplay: false,
                    seekToLive: false,
                    customControlSpacer: false,
                    descriptionsButton: false,
                    subsCapsButton: false,
                    audioTrackButton: false,
                },
                ...options?.adControls,
            };

            this.options = {
                ...{
                    adTagUrl: '',
                    adXml: '',
                    debug: false,
                    useVPAID: true,
                    showClose: true,
                    resolveAll: false, // Defaults parsing to the first ad in vast only
                    maxVPAIDAdStart: 5000,
                },
                ...options,
                ...{ adControls },
            };

            this.setup();
        }

        async setup() {
            const logger = getLogger(`prebid-outstream: ${this.player.id()}:`, this.options.debug);
            logger.debug('Initialize plugin with options', this.options);

            let tracker: VASTTracker | undefined;

            try {
                const props = { player: this.player, options: this.options, logger };
                const response = await parseVAST(props);

                // At this point, vast tracker should be reasonably instantiated
                logger.debug('Vast parsed: ', response);

                if (!response.ads) {
                    throw new VastError(VAST_NO_ADS, 'no ads found in vast');
                }

                // Set source order
                const originalSourceOrder = this.player.options_.sourceOrder;
                this.player.options({ sourceOrder: true });

                // Find linear creative from ads to display
                let display: DisplayMedia | Record<string, never> = {};
                for (const ad of response.ads) {
                    if (!ad.creatives) {
                        continue;
                    }

                    for (const creative of ad.creatives) {
                        if (!this.isLinearCreative(creative) || !creative.mediaFiles) {
                            continue;
                        }

                        // Give VPAID preference
                        let media = creative.mediaFiles.find((m) => m.apiFramework === 'VPAID');
                        if (!media) {
                            // Sort mediafiles by euclidean distance to player size
                            const sortedFiles = creative.mediaFiles
                                .filter((mediaFile) => mediaFile.mimeType !== 'video/x-flv')
                                .sort((a, b) => {
                                    const distanceA = Math.hypot(
                                        a.width - this.player.width(),
                                        a.height - this.player.height()
                                    );
                                    const distanceB = Math.hypot(
                                        b.width - this.player.width(),
                                        b.height - this.player.height()
                                    );
                                    return distanceA - distanceB;
                                });

                            const sources = sortedFiles.map<videojs.Tech.SourceObject>((mediaFile, index) => ({
                                src: mediaFile.fileURL || '',
                                type: mediaFile.mimeType || undefined,
                                index,
                            }));

                            const source = this.player.selectSource(sources);
                            if (source) {
                                media = sortedFiles[source.index];
                            }
                        }

                        if (media) {
                            display = {
                                ad,
                                creative,
                                media,
                            };

                            break;
                        }
                    }
                }

                // Revert player source order
                this.player.options({ sourceOrder: originalSourceOrder });

                if (!display.media) {
                    throw new VastError(LINEAR_ERROR, 'no suitable media found in vast');
                }

                logger.debug('Loading creative: ', display.creative);
                logger.debug('Loading media: ', display.media);

                const propsWithCreative: BaseWithCreative = { ...props, display: display as DisplayMedia };

                logger.debug('Setting up tracker...');
                tracker = createTracker(propsWithCreative);

                // TODO if the player fails to play ad source, forward error to tracker

                // Hide each control element except for the ones selected in the adControls
                // options
                Object.keys(this.options.adControls).forEach((key) => {
                    if (this.options.adControls[key]) {
                        this.player.controlBar.getChild(key)?.show();
                    } else {
                        this.player.controlBar.getChild(key)?.hide();
                    }
                });

                // Check for VPAID
                if (display.creative.apiFramework === 'VPAID' || display.media.apiFramework === 'VPAID') {
                    displayVPAID({ ...propsWithCreative, tracker });
                } else {
                    displayVASTNative({ ...propsWithCreative, tracker });
                }

                // Setup close button functionality
                if (this.options.showClose) {
                    this.player.el().appendChild(
                        CloseComponent({
                            onClick: () => {
                                logger.debug('Sending ad closed...');
                                this.player.trigger('adClose');
                                tracker!.skip();
                                // TODO: Unload ad
                            },
                        })
                    );
                }

                // Setup clickthrough tracking and functionality
                if (display.creative.videoClickThroughURLTemplate?.url) {
                    // Use mouseup and touchend event because
                    // 1. mouseup event changes player pause state when clicking on video
                    // 2. touch events are blocked for mobile: https://github.com/videojs/video.js/blob/main/src/js/player.js#L2044
                    ['mouseup', 'touchend'].forEach((eventName) => {
                        this.player.el().addEventListener(
                            eventName,
                            (e) => {
                                const elem = e.target as HTMLElement;
                                if (elem.tagName === 'VIDEO') {
                                    logger.debug('Sending click event on video...');
                                    this.player.trigger('adClick');
                                    tracker!.click();
                                }
                            },
                            { capture: true, passive: true }
                        );
                    });
                }

                // Listen on the window to determine if the current player should continue playing when
                // the document is in view again
                window.addEventListener('visibilitychange', this.onVisibilityChange);
                this.player.on('dispose', () => {
                    window.removeEventListener('visibilitychange', this.onVisibilityChange);
                });
            } catch (e) {
                logger.error('Exception caught: ', e);
                this.player.error(`POP: ${e.message}`);

                if (e instanceof VastError) {
                    // If tracker is defined fast-forward error to tracker
                    if (tracker) {
                        tracker.errorWithCode(e.vastErrorCode.toString());
                    }
                    this.player.trigger('adError');
                }

                // Also trigger player error
                this.player.trigger('error');
            }
        }

        onVisibilityChange = () => {
            const windowWidth = window.innerWidth || document.documentElement.clientWidth;
            const windowHeight = window.innerHeight || document.documentElement.clientHeight;

            const minLeft = windowWidth - this.player.width() > 0 ? 0 : windowWidth - this.player.width();
            const playerLocation = this.player.el().getBoundingClientRect();
            const isPlayerVisible =
                playerLocation.top >= 0 &&
                playerLocation.left >= minLeft &&
                playerLocation.bottom <= windowHeight &&
                playerLocation.right <= windowWidth;

            if (isPlayerVisible && !document.hidden && this.player.paused()) {
                // TODO Silence "uncaught play promise" error messages
                this.player.play();
            }

            if (document.hidden) {
                this.player.pause();
            }
        };

        isLinearCreative(creative?: VastCreative): creative is VastCreativeLinear {
            return creative?.type === 'linear';
        }
    };

    vjs.registerPlugin('outstream', Plugin);
}
