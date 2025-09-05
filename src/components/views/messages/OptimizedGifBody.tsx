/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
*/

import React, { useState, useRef, useEffect } from "react";
import { type MediaEventContent } from "matrix-js-sdk/src/types";
import { type IBodyProps } from "./IBodyProps";
import { useMediaVisible } from "../../../hooks/useMediaVisible";
import { mediaFromContent } from "../../../customisations/Media";
import { blobIsAnimated } from "../../../utils/Image";

interface OptimizedGifBodyProps extends IBodyProps {
    mediaVisible: boolean;
    setMediaVisible: (visible: boolean) => void;
}

/**
 * Optimized component for displaying GIF images with performance improvements
 */
export default function OptimizedGifBody({ 
    mxEvent, 
    mediaVisible, 
    setMediaVisible 
}: OptimizedGifBodyProps): JSX.Element {
    const [isLoaded, setIsLoaded] = useState(false);
    const [isAnimated, setIsAnimated] = useState(false);
    const [showFullGif, setShowFullGif] = useState(false);
    const [error, setError] = useState(false);
    const imgRef = useRef<HTMLImageElement>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);

    const content = mxEvent.getContent<MediaEventContent>();
    const media = mediaFromContent(content);
    const contentUrl = media.srcHttp;

    // Intersection Observer để lazy load GIF
    useEffect(() => {
        if (!imgRef.current) return;

        observerRef.current = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && !isLoaded) {
                        setIsLoaded(true);
                        observerRef.current?.disconnect();
                    }
                });
            },
            { 
                rootMargin: '50px', // Load 50px before entering viewport
                threshold: 0.1 
            }
        );

        observerRef.current.observe(imgRef.current);

        return () => {
            observerRef.current?.disconnect();
        };
    }, [isLoaded]);

    // Kiểm tra xem có phải GIF animated không
    useEffect(() => {
        if (!isLoaded || !contentUrl) return;

        const checkIfAnimated = async () => {
            try {
                const response = await fetch(contentUrl);
                const blob = await response.blob();
                const animated = await blobIsAnimated(blob);
                setIsAnimated(animated);
            } catch (e) {
                console.warn("Could not check if GIF is animated:", e);
                setIsAnimated(true); // Assume animated if check fails
            }
        };

        checkIfAnimated();
    }, [isLoaded, contentUrl]);

    const handleImageLoad = () => {
        setError(false);
    };

    const handleImageError = () => {
        setError(true);
    };

    const handleClick = () => {
        if (!mediaVisible) {
            setMediaVisible(true);
            return;
        }
        setShowFullGif(!showFullGif);
    };

    // Sử dụng thumbnail nếu có, fallback to content URL
    const imageUrl = content.info?.thumbnail_url || contentUrl;
    const shouldShowThumbnail = !showFullGif && content.info?.thumbnail_url && isAnimated;

    return (
        <div 
            className="mx_OptimizedGifBody"
            style={{
                position: 'relative',
                display: 'inline-block',
                maxWidth: '100%',
                cursor: 'pointer'
            }}
        >
            {!isLoaded ? (
                // Placeholder while loading
                <div 
                    ref={imgRef}
                    style={{
                        width: content.info?.w || 200,
                        height: content.info?.h || 200,
                        backgroundColor: '#f0f0f0',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '8px',
                        color: '#666'
                    }}
                >
                    📷
                </div>
            ) : error ? (
                // Error state
                <div 
                    style={{
                        width: content.info?.w || 200,
                        height: content.info?.h || 200,
                        backgroundColor: '#f0f0f0',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '8px',
                        color: '#999'
                    }}
                >
                    ❌
                </div>
            ) : (
                // Actual image
                <img
                    ref={imgRef}
                    src={shouldShowThumbnail ? imageUrl : contentUrl}
                    alt={content.body || "GIF"}
                    style={{
                        maxWidth: '100%',
                        height: 'auto',
                        borderRadius: '8px',
                        display: 'block'
                    }}
                    onClick={handleClick}
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                    loading="lazy"
                />
            )}

            {/* Play button overlay for animated GIFs */}
            {isLoaded && isAnimated && shouldShowThumbnail && (
                <div
                    style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        backgroundColor: 'rgba(0, 0, 0, 0.7)',
                        color: 'white',
                        borderRadius: '50%',
                        width: '40px',
                        height: '40px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '16px',
                        cursor: 'pointer'
                    }}
                    onClick={handleClick}
                >
                    ▶️
                </div>
            )}

            {/* GIF indicator */}
            {isLoaded && isAnimated && (
                <div
                    style={{
                        position: 'absolute',
                        top: '8px',
                        right: '8px',
                        backgroundColor: 'rgba(0, 0, 0, 0.7)',
                        color: 'white',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 'bold'
                    }}
                >
                    GIF
                </div>
            )}
        </div>
    );
}
